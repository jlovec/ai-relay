// ============================================================
// AI API Relay — Usage extraction
//
// Token counts live at different paths per upstream API (usage.prompt_tokens,
// usage.input_tokens, meta.tokens.input_tokens, ...). The path list is data on
// the EndpointSpec, so extraction is one generic lookup instead of one branch
// per endpoint.
// ============================================================

import type { EndpointSpec } from './spec';

function pickPath(source: unknown, path: string): number | undefined {
  let cursor: unknown = source;
  for (const key of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}

function pickFirst(source: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = pickPath(source, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

export interface ExtractedUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** True when the upstream reported at least one token count. */
  found: boolean;
}

/** Read usage out of an upstream JSON payload using the spec's path lists. */
export function extractUsage(spec: EndpointSpec, data: unknown): ExtractedUsage {
  const promptTokens = pickFirst(data, spec.usage.prompt);
  const completionTokens = pickFirst(data, spec.usage.completion);
  return {
    promptTokens,
    completionTokens,
    found: promptTokens !== undefined || completionTokens !== undefined,
  };
}

/**
 * Normalise extracted usage into recorded values, falling back to the local
 * estimate only when the upstream reported nothing usable.
 */
export function resolveUsageTokens(
  extracted: ExtractedUsage,
  estimatedPromptTokens: number,
  fallbackCompletionTokens: number
): { promptTokens: number; completionTokens: number; usedFallback: boolean } {
  const prompt = extracted.promptTokens ?? (extracted.found ? 0 : estimatedPromptTokens);
  let completion = extracted.completionTokens ?? 0;
  let usedFallback = false;

  // Chat-style upstreams that report only prompt tokens still need a
  // non-zero completion for accounting; estimate it from the response body.
  if (!extracted.found || (prompt === 0 && completion === 0)) {
    usedFallback = true;
    return {
      promptTokens: extracted.promptTokens ?? estimatedPromptTokens,
      completionTokens: extracted.completionTokens ?? fallbackCompletionTokens,
      usedFallback,
    };
  }

  return { promptTokens: prompt, completionTokens: completion, usedFallback };
}
