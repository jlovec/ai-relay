// ============================================================
// AI API Relay — GET /v1/models
//
// Lists all available models in OpenAI-compatible format.
// Spec: https://platform.openai.com/docs/api-reference/models
// ============================================================

import { NextRequest } from 'next/server';
import { getAllProviders, pickPriorityRuleProvider } from '@/lib/providers';
import { getModelAliasConfig, getPriorityRules } from '@/lib/admin/admin-config';
import { findMatchingPriorityRule } from '@/lib/admin/priority-rules-core';
import { getKeyPoolStats, initAllKeyPools, validateAuth } from '@/lib/relay';
import type { ModelInfo } from '@/lib/providers/types';

export const runtime = 'nodejs';

/** Timestamp when this relay was started (used as model creation date) */
const RELAY_CREATED = Math.floor(Date.now() / 1000);

type ListedModel = ModelInfo & { owned_by: string; configured: boolean };

/**
 * Collapse duplicate model ids to one entry.
 *
 * Every provider that declares a model used to contribute its own row, so a
 * model served by three channels appeared three times. Clients read this list
 * to build model pickers, so the duplicate rows showed the same model with
 * different `owned_by` and `context_window` values and no way to tell which
 * one a request would actually reach.
 *
 * The first occurrence wins, and callers order the input so that occurrence is
 * the provider the router prefers.
 */
function dedupeModels(models: ListedModel[]): ListedModel[] {
  const seen = new Set<string>();
  const unique: ListedModel[] = [];
  for (const model of models) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(model);
  }
  return unique;
}

/**
 * Build the full models list from provider registry.
 *
 * `owned_by` names the provider that would serve the model, which is not
 * always the provider that declared it: a priority rule can redirect a model
 * to another channel. Resolving that here keeps the listing honest — a client
 * reading `owned_by` sees where the request goes, not an artefact of which
 * channel happened to declare the model.
 */
async function getAllModels(): Promise<ListedModel[]> {
  const allProviders = await getAllProviders();
  await initAllKeyPools(allProviders);
  const poolStats = getKeyPoolStats();
  const priorityRules = await getPriorityRules();

  const isUsable = (providerId: string, config: { envKeyField?: string }) => {
    const configured = config.envKeyField ? (!!process.env[config.envKeyField] || (poolStats[providerId]?.total > 0)) : (poolStats[providerId]?.total > 0);
    const hasKeys = (poolStats[providerId]?.available || 0) > 0;
    return configured && hasKeys;
  };

  const models: ListedModel[] = [];

  for (const [providerId, config] of Object.entries(allProviders)) {
    if (config.models && config.models.length > 0) {
      // Use explicit model list
      for (const model of config.models) {
        models.push({
          ...model,
          owned_by: providerId,
          configured: isUsable(providerId, config),
        });
      }
    } else {
      // Fallback: generate placeholder models from prefixes
      for (const prefix of config.modelPrefixes) {
        models.push({
          id: `${prefix}default`,
          displayName: `${config.displayName} (${prefix}*)`,
          contextWindow: 128000,
          owned_by: providerId,
          configured: isUsable(providerId, config),
        });
      }
    }
  }

  // Re-attribute models that a priority rule routes elsewhere, then drop the
  // rows that the rule made redundant. Processing routed models first lets
  // dedupeModels keep the routed provider's row.
  const routed = new Map<string, ListedModel>();
  for (const model of models) {
    const rule = findMatchingPriorityRule(priorityRules, model.id.toLowerCase());
    if (!rule) continue;
    const winner = pickPriorityRuleProvider(rule.providerOrder, allProviders);
    if (!winner) continue;
    routed.set(model.id.toLowerCase(), {
      ...model,
      owned_by: winner.id,
      configured: isUsable(winner.id, winner.config),
    });
  }

  const ordered: ListedModel[] = [];
  for (const model of models) {
    const rerouted = routed.get(model.id.toLowerCase());
    // Only emit the routed row once, at the position of its first declaration.
    if (rerouted) {
      if (ordered.some((entry) => entry.id.toLowerCase() === model.id.toLowerCase())) continue;
      ordered.push(rerouted);
      continue;
    }
    ordered.push(model);
  }

  return dedupeModels(ordered);
}

/**
 * GET /v1/models
 *
 * Returns all available models in OpenAI-compatible format.
 */
export async function GET(request: NextRequest) {
  // Optional: auth check (some clients expect /v1/models to be public)
  const authHeader = request.headers.get('authorization');

  // If auth is provided, validate it; otherwise allow unauthenticated access
  if (authHeader) {
    const isValid = await validateAuth(request);
    if (!isValid) {
      return Response.json(
        { error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 401 } },
        { status: 401 }
      );
    }
  }

  const allModels = await getAllModels();
  const aliasConfig = await getModelAliasConfig();
  const hiddenModels = new Set(aliasConfig.hidden);
  const visibleModels = allModels.filter((model) => !hiddenModels.has(model.id));

  // OpenAI-compatible response format
  return Response.json({
    object: 'list',
    data: visibleModels.map((model) => ({
      id: model.id,
      object: 'model',
      created: RELAY_CREATED,
      owned_by: model.owned_by,
      // Extended fields (non-standard but useful)
      display_name: model.displayName,
      context_window: model.contextWindow,
      max_output: model.maxOutput || null,
      supports_stream: model.supportsStream ?? true,
      supports_vision: model.supportsVision ?? false,
      supports_tools: model.supportsTools ?? false,
      pricing: model.pricing || null,
      configured: model.configured,
    })),
  });
}
