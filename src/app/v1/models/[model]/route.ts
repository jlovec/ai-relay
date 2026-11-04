// ============================================================
// AI API Relay — GET /v1/models/:model
//
// Returns info about a specific model in OpenAI-compatible format.
// Spec: https://platform.openai.com/docs/api-reference/models/retrieve
// ============================================================

import { NextRequest } from 'next/server';
import { getAllProviders, pickPriorityRuleProvider, providerSupportsModel } from '@/lib/providers';
import { getPriorityRules } from '@/lib/admin/admin-config';
import { findMatchingPriorityRule } from '@/lib/admin/priority-rules-core';
import { getKeyPoolStats, initAllKeyPools, getRelayApiKeys } from '@/lib/relay';
import type { ModelInfo } from '@/lib/providers/types';

export const runtime = 'nodejs';

const RELAY_CREATED = Math.floor(Date.now() / 1000);

/**
 * Find a specific model by ID across all providers.
 *
 * `owned_by` reports the provider that would serve the model. A priority rule
 * can redirect a model that another channel declares, so the declaring entry
 * supplies the model metadata while the rule decides the attribution — the
 * same split /v1/models uses.
 */
async function findModel(modelId: string): Promise<(ModelInfo & { owned_by: string; configured: boolean }) | null> {
  const allProviders = await getAllProviders();
  await initAllKeyPools(allProviders);
  const poolStats = getKeyPoolStats();

  const isUsable = (providerId: string, config: { envKeyField?: string }) => {
    const configured = config.envKeyField ? (!!process.env[config.envKeyField] || (poolStats[providerId]?.total > 0)) : (poolStats[providerId]?.total > 0);
    const hasKeys = (poolStats[providerId]?.available || 0) > 0;
    return configured && hasKeys;
  };

  const wanted = modelId.toLowerCase();
  let declared: ModelInfo | null = null;
  let declaringProvider: string | null = null;

  for (const [providerId, config] of Object.entries(allProviders)) {
    const found = config.models?.find((m) => m.id.toLowerCase() === wanted);
    if (found) {
      declared = found;
      declaringProvider = providerId;
      break;
    }
  }

  if (!declared) {
    // No provider declares it — fall back to prefix matching so a model that
    // the router would still accept is not reported as missing.
    for (const [providerId, config] of Object.entries(allProviders)) {
      if (providerSupportsModel(config, wanted)) {
        declaringProvider = providerId;
        break;
      }
    }
    if (!declaringProvider) return null;
    return { id: modelId, displayName: modelId, contextWindow: 128000, owned_by: declaringProvider, configured: isUsable(declaringProvider, allProviders[declaringProvider]) };
  }

  const rule = findMatchingPriorityRule(await getPriorityRules(), wanted);
  const winner = rule ? pickPriorityRuleProvider(rule.providerOrder, allProviders) : null;
  const servingId = winner?.id ?? declaringProvider!;
  const servingConfig = winner?.config ?? allProviders[servingId];

  return {
    ...declared,
    owned_by: servingId,
    configured: isUsable(servingId, servingConfig),
  };
}

/**
 * GET /v1/models/:model
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ model: string }> }
) {
  const { model: modelParam } = await params;
  const modelId = decodeURIComponent(modelParam);

  // Optional auth
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '') || '';
  if (token) {
    const validKeys = getRelayApiKeys();
    if (!validKeys.includes(token)) {
      return Response.json(
        { error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 401 } },
        { status: 401 }
      );
    }
  }

  const model = await findModel(modelId);
  if (!model) {
    return Response.json(
      {
        error: {
          message: `The model '${modelId}' does not exist.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      },
      { status: 404 }
    );
  }

  return Response.json({
    id: model.id,
    object: 'model',
    created: RELAY_CREATED,
    owned_by: model.owned_by,
    display_name: model.displayName,
    context_window: model.contextWindow,
    max_output: model.maxOutput || null,
    supports_stream: model.supportsStream ?? true,
    supports_vision: model.supportsVision ?? false,
    supports_tools: model.supportsTools ?? false,
    pricing: model.pricing || null,
    configured: model.configured,
  });
}
