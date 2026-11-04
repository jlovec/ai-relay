import { describe, expect, it, vi } from 'vitest';
import { ENDPOINTS, supportsHeaderFormat, streamNeedsTranslation } from '../lib/relay/endpoints/spec';
import { validateRequiredFields } from '../lib/relay/endpoints/validate';
import { extractUsage } from '../lib/relay/endpoints/usage';

describe('endpoint spec table', () => {
  it('covers every relay API type with the same required shape', () => {
    const types = ['chat', 'anthropicMessages', 'responses', 'embeddings', 'rerank'] as const;
    for (const type of types) {
      const spec = ENDPOINTS[type];
      expect(spec.apiType).toBe(type);
      expect(spec.required.length).toBeGreaterThan(0);
      expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
      expect(typeof spec.errorStyle).toBe('string');
    }
  });

  it('never routes passthrough endpoints to an Anthropic provider', () => {
    expect(supportsHeaderFormat(ENDPOINTS.responses, 'anthropic')).toBe(false);
    expect(supportsHeaderFormat(ENDPOINTS.embeddings, 'anthropic')).toBe(false);
    expect(supportsHeaderFormat(ENDPOINTS.rerank, 'anthropic')).toBe(false);
  });

  it('lets chat fall back to an Anthropic provider via /messages', () => {
    expect(supportsHeaderFormat(ENDPOINTS.chat, 'anthropic')).toBe(true);
    expect(ENDPOINTS.chat.paths.anthropic).toBe('/messages');
    expect(ENDPOINTS.chat.paths.openai).toBe('/chat/completions');
  });

  it('declares no stream for embeddings and rerank', () => {
    expect(ENDPOINTS.embeddings.stream).toBeNull();
    expect(ENDPOINTS.rerank.stream).toBeNull();
  });

  it('only needs stream translation when protocols differ', () => {
    expect(streamNeedsTranslation(ENDPOINTS.chat, 'openai')).toBe(false);
    expect(streamNeedsTranslation(ENDPOINTS.chat, 'anthropic')).toBe(true);
    expect(streamNeedsTranslation(ENDPOINTS.anthropicMessages, 'openai')).toBe(true);
    expect(streamNeedsTranslation(ENDPOINTS.anthropicMessages, 'anthropic')).toBe(false);
    expect(streamNeedsTranslation(ENDPOINTS.embeddings, 'openai')).toBe(false);
  });
});

describe('declarative validation', () => {
  it('reports the first missing field', () => {
    expect(validateRequiredFields(ENDPOINTS.embeddings.required, {})).toContain('model');
    expect(validateRequiredFields(ENDPOINTS.embeddings.required, { model: 'm' })).toContain('input');
  });

  it('enforces max_tokens as a positive number on messages', () => {
    const required = ENDPOINTS.anthropicMessages.required;
    expect(validateRequiredFields(required, { model: 'claude-x', messages: [{}] })).toContain('max_tokens');
    expect(validateRequiredFields(required, { model: 'claude-x', max_tokens: 0, messages: [{}] })).toContain('max_tokens');
    expect(validateRequiredFields(required, { model: 'claude-x', max_tokens: 16, messages: [{}] })).toBeNull();
  });

  it('rejects empty arrays only where notEmpty is set', () => {
    const required = ENDPOINTS.rerank.required;
    expect(validateRequiredFields(required, { model: 'm', query: 'q', documents: [] })).toContain('documents');
    expect(validateRequiredFields(required, { model: 'm', query: 'q', documents: ['a'] })).toBeNull();
  });
});

describe('usage extraction', () => {
  it('reads chat usage from prompt_tokens', () => {
    const usage = extractUsage(ENDPOINTS.chat, { usage: { prompt_tokens: 5, completion_tokens: 3 } });
    expect(usage).toMatchObject({ promptTokens: 5, completionTokens: 3, found: true });
  });

  it('reads messages usage from input_tokens', () => {
    const usage = extractUsage(ENDPOINTS.anthropicMessages, { usage: { input_tokens: 7, output_tokens: 2 } });
    expect(usage).toMatchObject({ promptTokens: 7, completionTokens: 2, found: true });
  });

  it('reads rerank usage from meta.tokens.input_tokens', () => {
    const usage = extractUsage(ENDPOINTS.rerank, { meta: { tokens: { input_tokens: 20, output_tokens: 0 } } });
    expect(usage.promptTokens).toBe(20);
    expect(usage.found).toBe(true);
  });

  it('reports not-found when the upstream omits usage everywhere', () => {
    const usage = extractUsage(ENDPOINTS.embeddings, { data: [] });
    expect(usage.found).toBe(false);
  });
});

describe('all endpoints share one handler shape', () => {
  it('exposes POST plus the same runtime config on every route', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const routes = [
      '../app/v1/chat/completions/route',
      '../app/v1/messages/route',
      '../app/v1/responses/route',
      '../app/v1/embeddings/route',
      '../app/v1/rerank/route',
    ] as const;

    for (const path of routes) {
      const mod = await import(path);
      expect(typeof mod.POST).toBe('function');
      expect(mod.runtime).toBe('nodejs');
      expect(mod.maxDuration).toBe(300);
    }
  });
});
