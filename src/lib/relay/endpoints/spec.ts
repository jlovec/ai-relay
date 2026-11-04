// ============================================================
// AI API Relay — Endpoint Specification (single source of truth)
//
// Every /v1 endpoint is one row in ENDPOINTS. All per-endpoint behaviour
// differences (upstream path, protocol translation, field validation, stream
// framing, usage extraction) are expressed as data here — no `if
// (apiType === ...)` branches belong outside this file.
// ============================================================

export type RelayApiType =
  | 'chat'
  | 'anthropicMessages'
  | 'responses'
  | 'embeddings'
  | 'rerank';

export type HeaderFormat = 'openai' | 'anthropic' | 'azure';

/**
 * Wire protocol the *client* speaks.
 *   openai-chat — /chat/completions body (messages[])
 *   anthropic   — /messages body (system + messages[] + max_tokens)
 *   passthrough — forwarded verbatim, only the model is swapped
 */
export type SourceFormat = 'openai-chat' | 'anthropic' | 'passthrough';

/**
 * SSE framing the *client* expects, or null when the endpoint has no stream.
 * The upstream framing is implied by the provider's headerFormat, so the
 * pair (stream, headerFormat) fully determines whether translation is needed.
 */
export type StreamKind = 'openai-chat' | 'anthropic' | 'responses' | null;

export type EstimateKind = 'chat' | 'messages' | 'responses' | 'embeddings' | 'rerank';

export interface RequiredField {
  field: string;
  /**
   * Presence/shape check:
   *   any            — must not be null/undefined
   *   nonEmptyString — must be a string with length > 0
   *   array          — must be an array (use notEmpty to reject [])
   *   positiveNumber — must be a finite number > 0
   */
  kind?: 'any' | 'nonEmptyString' | 'array' | 'positiveNumber';
  /** When true an array/string of length 0 is rejected. */
  notEmpty?: boolean;
}

export interface EndpointSpec {
  apiType: RelayApiType;

  /** Wire protocol the client speaks. */
  sourceFormat: SourceFormat;

  /**
   * JSON error envelope the client expects:
   *   openai    — { error: { message, type, code } }
   *   anthropic — { error: { type, message } }
   */
  errorStyle: 'openai' | 'anthropic';

  /**
   * Upstream path per target header format. The key set doubles as the
   * allowlist of header formats this endpoint can be relayed to — a missing
   * key means "this provider format cannot serve this endpoint" (→ 400).
   *
   * Note the path follows the *target* protocol, not the source: a GPT request
   * falling back to an Anthropic provider goes to /messages (see chat below).
   */
  paths: Partial<Record<HeaderFormat, string>>;

  /** Declarative required-field validation, evaluated in order. */
  required: RequiredField[];

  /**
   * When set, the alias-resolved model must start with this prefix — the
   * endpoint's protocol only serves that model family (e.g. /v1/messages is
   * Claude-only). Checked against the *resolved* name, not the raw input.
   */
  requireModelPrefix?: string;

  /** Client-side SSE framing; null when the endpoint has no streaming mode. */
  stream: StreamKind;

  /** Where to read token counts from the upstream JSON, in priority order. */
  usage: {
    prompt: string[];
    completion: string[];
    estimate: EstimateKind;
  };
}

const OPENAI_CHAT_PATHS = {
  openai: '/chat/completions',
  azure: '/chat/completions',
  anthropic: '/messages',
} as const;

export const ENDPOINTS: Record<RelayApiType, EndpointSpec> = {
  chat: {
    apiType: 'chat',
    sourceFormat: 'openai-chat',
    errorStyle: 'openai',
    paths: { ...OPENAI_CHAT_PATHS },
    required: [
      { field: 'model', kind: 'nonEmptyString' },
      { field: 'messages', kind: 'array', notEmpty: true },
    ],
    stream: 'openai-chat',
    usage: {
      prompt: ['usage.prompt_tokens', 'usage.input_tokens'],
      completion: ['usage.completion_tokens', 'usage.output_tokens'],
      estimate: 'chat',
    },
  },

  anthropicMessages: {
    apiType: 'anthropicMessages',
    sourceFormat: 'anthropic',
    errorStyle: 'anthropic',
    paths: { ...OPENAI_CHAT_PATHS },
    required: [
      { field: 'model', kind: 'nonEmptyString' },
      { field: 'max_tokens', kind: 'positiveNumber' },
      { field: 'messages', kind: 'array', notEmpty: true },
    ],
    requireModelPrefix: 'claude-',
    stream: 'anthropic',
    usage: {
      prompt: ['usage.input_tokens', 'usage.prompt_tokens'],
      completion: ['usage.output_tokens', 'usage.completion_tokens'],
      estimate: 'messages',
    },
  },

  responses: {
    apiType: 'responses',
    sourceFormat: 'passthrough',
    errorStyle: 'openai',
    paths: { openai: '/responses', azure: '/responses' },
    required: [
      { field: 'model', kind: 'nonEmptyString' },
      { field: 'input', notEmpty: true },
    ],
    stream: 'responses',
    usage: {
      prompt: ['usage.prompt_tokens', 'usage.input_tokens'],
      completion: ['usage.completion_tokens', 'usage.output_tokens'],
      estimate: 'responses',
    },
  },

  embeddings: {
    apiType: 'embeddings',
    sourceFormat: 'passthrough',
    errorStyle: 'openai',
    paths: { openai: '/embeddings', azure: '/embeddings' },
    required: [
      { field: 'model', kind: 'nonEmptyString' },
      { field: 'input', notEmpty: true },
    ],
    stream: null,
    usage: {
      prompt: ['usage.prompt_tokens'],
      completion: [],
      estimate: 'embeddings',
    },
  },

  rerank: {
    apiType: 'rerank',
    sourceFormat: 'passthrough',
    errorStyle: 'openai',
    paths: { openai: '/rerank', azure: '/rerank' },
    required: [
      { field: 'model', kind: 'nonEmptyString' },
      { field: 'query', kind: 'nonEmptyString' },
      { field: 'documents', kind: 'array', notEmpty: true },
    ],
    stream: null,
    usage: {
      prompt: ['meta.tokens.input_tokens', 'usage.prompt_tokens'],
      completion: [],
      estimate: 'rerank',
    },
  },
};

/** Whether the target provider format can serve this endpoint at all. */
export function supportsHeaderFormat(spec: EndpointSpec, format: HeaderFormat): boolean {
  return spec.paths[format] !== undefined;
}

/**
 * Whether the upstream SSE framing differs from what the client expects and
 * therefore needs translation (and cannot use the cheap byte-counting
 * passthrough on Cloudflare).
 */
export function streamNeedsTranslation(spec: EndpointSpec, format: HeaderFormat): boolean {
  if (spec.stream === null) return false;
  const clientWantsAnthropic = spec.stream === 'anthropic';
  const upstreamIsAnthropic = format === 'anthropic';
  return clientWantsAnthropic !== upstreamIsAnthropic;
}
