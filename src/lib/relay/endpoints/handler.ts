// ============================================================
// AI API Relay — Unified endpoint handler
//
// Every /v1 route is `createRelayHandler(ENDPOINTS.<name>)`. The whole request
// lifecycle lives here exactly once:
//
//   auth → parse → size guard → field validation → quota → relay
//        → (stream | non-stream) → usage recording → error envelope
//
// Per-endpoint differences arrive as data (EndpointSpec) and are consumed by
// the three matrices in ./body, ./usage and ./stream.
// ============================================================

import type { NextRequest } from 'next/server';
import { validateAuth, relayRequest } from '@/lib/relay';
import {
  validateBase64ImageSizes,
  validateRequestSize,
} from '@/lib/relay/validation';
import { collectPassthroughHeaders } from '@/lib/relay/passthrough';
import {
  transformOpenAIToAnthropic,
  transformAnthropicMessageToOpenAIChat,
} from '@/lib/relay/transform';
import { RelayError } from '@/lib/errors';
import { createUsageEvent, getBatchRecorder } from '@/lib/usage';
import { createUsageStorage } from '@/lib/usage/factory';
import { recordRequestLog } from '@/lib/observability/request-logs';
import { isCloudflareSync, runAfterResponse } from '@/lib/cf-env';
import type { EndpointSpec } from './spec';
import { streamNeedsTranslation } from './spec';
import { validateRequiredFields, estimatePromptTokensFor, estimateTokens } from './validate';
import { extractUsage, resolveUsageTokens } from './usage';
import {
  wrapSseStreamWithUsageTracking,
  wrapAnthropicStreamToOpenAIChat,
  wrapOpenAIChatStreamToAnthropic,
  wrapAnthropicStreamWithUsageTracking,
  wrapResponsesStreamWithUsageTracking,
  createByteCountingStream,
  estimateCompletionTokensFromStreamBytes,
  type UsageReporter,
} from './stream';

const batchRecorder = getBatchRecorder();

// ── Error envelopes ─────────────────────────────────────────────────────

function errorResponse(
  spec: EndpointSpec,
  status: number,
  message: string,
  type: string
): Response {
  const error =
    spec.errorStyle === 'anthropic'
      ? { type, message }
      : { message, type, code: status };

  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function relayErrorResponse(spec: EndpointSpec, error: RelayError): Response {
  return errorResponse(spec, error.status, error.message, error.type);
}

// ── Usage recording ─────────────────────────────────────────────────────

interface RecordContext {
  traceId: string;
  startedAt: number;
  apiKeyHash: string;
  providerName: string;
  model: string;
  stream: boolean;
}

async function recordUsage(
  ctx: RecordContext,
  promptTokens: number,
  completionTokens: number,
  statusCode = 200
): Promise<void> {
  const latencyMs = Date.now() - ctx.startedAt;
  const event = createUsageEvent({
    provider: ctx.providerName,
    model: ctx.model,
    apiKeyHash: ctx.apiKeyHash,
    statusCode,
    promptTokens,
    completionTokens,
    latencyMs,
    isStream: ctx.stream,
  });
  await batchRecorder.record(event);
  await recordRequestLog({
    traceId: ctx.traceId,
    timestamp: new Date().toISOString(),
    apiKeyHash: ctx.apiKeyHash,
    model: ctx.model,
    provider: ctx.providerName,
    status: 'success',
    httpStatus: statusCode,
    latencyMs,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    isStream: ctx.stream,
  });
}

function usageReporter(ctx: RecordContext): UsageReporter {
  return (promptTokens, completionTokens) => recordUsage(ctx, promptTokens, completionTokens);
}

// ── Stream selection ────────────────────────────────────────────────────

function selectStream(
  spec: EndpointSpec,
  upstreamBody: ReadableStream<Uint8Array>,
  upstreamIsAnthropic: boolean,
  model: string,
  estimatedPromptTokens: number,
  onUsage: UsageReporter
): ReadableStream<Uint8Array> {
  if (streamNeedsTranslation(spec, upstreamIsAnthropic ? 'anthropic' : 'openai')) {
    return spec.stream === 'anthropic'
      ? wrapOpenAIChatStreamToAnthropic(upstreamBody, model, estimatedPromptTokens, onUsage)
      : wrapAnthropicStreamToOpenAIChat(upstreamBody, model, estimatedPromptTokens, onUsage);
  }

  switch (spec.stream) {
    case 'anthropic':
      return wrapAnthropicStreamWithUsageTracking(upstreamBody, estimatedPromptTokens, onUsage);
    case 'responses':
      return wrapResponsesStreamWithUsageTracking(upstreamBody, estimatedPromptTokens, onUsage);
    default:
      return wrapSseStreamWithUsageTracking(upstreamBody, upstreamIsAnthropic, estimatedPromptTokens, onUsage);
  }
}

// ── Handler factory ─────────────────────────────────────────────────────

export function createRelayHandler(spec: EndpointSpec) {
  return async function POST(request: NextRequest): Promise<Response> {
    const traceId =
      request.headers.get('x-request-id') ||
      `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // 1. Auth
    if (!(await validateAuth(request))) {
      return errorResponse(
        spec,
        401,
        'Invalid API key. Provide a valid key in the Authorization or x-api-key header.',
        'authentication_error'
      );
    }

    const usageStorage = await createUsageStorage();
    batchRecorder.setStorage(usageStorage as never);

    // 2. Parse body (keep raw text on Cloudflare for byte-identical forwarding)
    const onCloudflare = isCloudflareSync();
    let body: Record<string, unknown>;
    let rawBody: string | undefined;
    try {
      if (onCloudflare) {
        rawBody = await request.text();
        body = JSON.parse(rawBody);
      } else {
        body = await request.json();
      }
    } catch {
      return errorResponse(spec, 400, 'Invalid JSON in request body.', 'invalid_request_error');
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse(spec, 400, 'Invalid JSON in request body.', 'invalid_request_error');
    }

    // 2b. Oversized-payload guard: precise base64 scan on Node, cheap
    // total-size cap on Cloudflare (the deep scan blows the CPU budget).
    const sizeCheck = onCloudflare
      ? validateRequestSize(rawBody?.length ?? 0)
      : validateBase64ImageSizes(body);
    if (!sizeCheck.valid) {
      return errorResponse(spec, 400, sizeCheck.error || 'Request too large.', 'invalid_request_error');
    }

    // 3. Required fields
    const validationError = validateRequiredFields(spec.required, body);
    if (validationError) {
      return errorResponse(spec, 400, validationError, 'invalid_request_error');
    }

    // 4. Quota
    const quota = await usageStorage.checkQuota(true);
    if (!quota.allowed) {
      return new Response(
        JSON.stringify(
          spec.errorStyle === 'anthropic'
            ? {
                error: {
                  type: 'rate_limit_error',
                  message: `Rate limit exceeded. Daily: ${quota.dailyUsed}/${quota.dailyLimit}, Monthly: ${quota.monthlyUsed}/${quota.monthlyLimit}. Retry after ${quota.retryAfter}s.`,
                },
              }
            : {
                error: {
                  message: `Rate limit exceeded. Daily: ${quota.dailyUsed}/${quota.dailyLimit}, Monthly: ${quota.monthlyUsed}/${quota.monthlyLimit}. Retry after ${quota.retryAfter}s.`,
                  type: 'rate_limit_error',
                  code: 429,
                },
              }
        ),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(quota.retryAfter || 60),
          },
        }
      );
    }

    const model = String(body.model);
    const estimatedPromptTokens = estimatePromptTokensFor(spec.usage.estimate, body);
    const wantsStream = spec.stream !== null && !!body.stream;

    // 5. Relay
    const startedAt = Date.now();
    try {
      const userAgent = request.headers.get('user-agent') || undefined;
      const passthroughHeaders = collectPassthroughHeaders(request.headers);
      const { response, provider, apiKey } = await relayRequest(
        body as never,
        spec.apiType,
        userAgent,
        rawBody,
        passthroughHeaders
      );

      const ctx: RecordContext = {
        traceId,
        startedAt,
        apiKeyHash: apiKey.hash,
        providerName: provider.name,
        model,
        stream: wantsStream,
      };

      const upstreamIsAnthropic = provider.headerFormat === 'anthropic';

      // 6a. Streaming
      if (wantsStream && response.ok && response.body) {
        const needsTranslation = streamNeedsTranslation(spec, provider.headerFormat);

        // Cloudflare Free: translation is mandatory where needed, otherwise the
        // byte-counting passthrough keeps CPU near-constant per byte.
        if (isCloudflareSync() && !needsTranslation) {
          const cfBody = createByteCountingStream(response.body, (totalBytes) => {
            const completionTokens = estimateCompletionTokensFromStreamBytes(totalBytes);
            runAfterResponse(async () => {
              await recordUsage(ctx, estimatedPromptTokens, completionTokens);
            });
          });
          return streamResponse(cfBody, response.status, provider.name, apiKey.hash);
        }

        const wrapped = selectStream(
          spec,
          response.body,
          upstreamIsAnthropic,
          model,
          estimatedPromptTokens,
          usageReporter(ctx)
        );
        return streamResponse(wrapped, response.status, provider.name, apiKey.hash);
      }

      // 6b. Non-streaming (also every upstream error body — returned as-is)
      let responseBody = await response.text();
      const contentType = response.headers.get('content-type');

      if (response.ok) {
        try {
          let data: unknown = JSON.parse(responseBody);
          const translated = translateResponse(spec, data, model, upstreamIsAnthropic);

          if (translated !== null) {
            data = translated;
            responseBody = JSON.stringify(translated);
          }

          // Endpoints that report no completion tokens (embeddings, rerank)
          // declare an empty completion path list — never estimate a body size
          // for them, since their payloads are results, not generated text.
          const fallbackCompletionTokens =
            spec.usage.completion.length > 0 ? estimateTokens(responseBody) : 0;

          const resolved = resolveUsageTokens(
            extractUsage(spec, data),
            estimatedPromptTokens,
            fallbackCompletionTokens
          );

          await recordUsage(ctx, resolved.promptTokens, resolved.completionTokens, response.status);
        } catch (error) {
          console.error(`[Usage] ${spec.apiType} non-stream tracking failed:`, error);
        }
      }

      return new Response(responseBody, {
        status: response.status,
        headers: {
          'Content-Type':
            spec.sourceFormat === 'anthropic'
              ? upstreamIsAnthropic
                ? contentType || 'application/json'
                : 'application/json'
              : 'application/json',
          'X-Relay-Provider': provider.name,
          'X-Relay-Key': apiKey.hash,
        },
      });
    } catch (error) {
      if (error instanceof RelayError) {
        return relayErrorResponse(spec, error);
      }

      // Spec-level rejections (e.g. upstream format cannot serve this endpoint)
      if (error instanceof Error && error.message.includes('not supported for Anthropic')) {
        return errorResponse(spec, 400, error.message, 'invalid_request_error');
      }

      console.error(`[relay] ${spec.apiType} error:`, error);
      return errorResponse(spec, 500, 'Internal relay error.', 'server_error');
    }
  };
}

function streamResponse(
  body: ReadableStream<Uint8Array>,
  status: number,
  providerName: string,
  apiKeyHash: string
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Relay-Provider': providerName,
      'X-Relay-Key': apiKeyHash,
    },
  });
}

/**
 * Translate a non-streaming upstream body when the client protocol differs from
 * the provider protocol. Returns the replacement payload, or null when the body
 * already matches the client's protocol and must be forwarded untouched.
 */
function translateResponse(
  spec: EndpointSpec,
  data: unknown,
  model: string,
  upstreamIsAnthropic: boolean
): Record<string, unknown> | null {
  if (spec.sourceFormat === 'passthrough') return null;

  const clientWantsAnthropic = spec.sourceFormat === 'anthropic';
  if (clientWantsAnthropic === upstreamIsAnthropic) return null;

  const payload = data as Record<string, unknown>;

  if (clientWantsAnthropic) {
    // OpenAI chat response → Anthropic Messages
    return transformOpenAIToAnthropic(payload, model) as Record<string, unknown>;
  }

  // Anthropic Messages → OpenAI chat response
  return transformAnthropicMessageToOpenAIChat(payload, model) as unknown as Record<string, unknown>;
}
