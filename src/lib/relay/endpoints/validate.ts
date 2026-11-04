// ============================================================
// AI API Relay — Declarative validation
//
// Required-field checks are data on the EndpointSpec; this turns them into
// an error message. Keeping it declarative is what lets every endpoint share
// one request path.
// ============================================================

import type { RequiredField } from './spec';

const CHARS_PER_TOKEN = 4;

function isPositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function checkField(rule: RequiredField, body: Record<string, unknown>): string | null {
  const value = body[rule.field];

  if (value === undefined || value === null) {
    return `Missing required field: ${rule.field}.`;
  }

  switch (rule.kind) {
    case 'nonEmptyString':
      if (typeof value !== 'string' || value.length === 0) {
        return `Missing or invalid required field: ${rule.field}.`;
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        return `Missing or invalid required field: ${rule.field}.`;
      }
      if (rule.notEmpty && value.length === 0) {
        return `Missing or empty required field: ${rule.field}.`;
      }
      break;
    case 'positiveNumber':
      if (!isPositiveNumber(value)) {
        return `Missing or invalid required field: ${rule.field}.`;
      }
      break;
    default:
      if (rule.notEmpty && isEmptyValue(value)) {
        return `Missing or empty required field: ${rule.field}.`;
      }
  }

  return null;
}

/** Returns the first validation error message, or null when the body is valid. */
export function validateRequiredFields(
  required: RequiredField[],
  body: Record<string, unknown>
): string | null {
  for (const rule of required) {
    const error = checkField(rule, body);
    if (error) return error;
  }
  return null;
}

// ── Prompt-token estimation ──────────────────────────────────────────────
// Only used when the upstream omits usage (or the stream ends without it).

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      text += (part as { text: string }).text;
    }
  }
  return text;
}

export function estimateChatPromptTokens(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return 0;
  let totalChars = 0;
  let imageCount = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === 'string') {
      totalChars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const obj = part as Record<string, unknown>;
        if (typeof obj.text === 'string') {
          totalChars += obj.text.length;
        } else if (obj.type === 'image_url') {
          imageCount++;
        }
      }
    }
  }
  // Rough cost of a standard low-res image.
  return Math.max(1, Math.ceil(totalChars / CHARS_PER_TOKEN) + imageCount * 85);
}

export function estimateAnthropicPromptTokens(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const messageText = messages
    .map((message) => {
      if (!message || typeof message !== 'object') return '';
      return contentToText((message as Record<string, unknown>).content);
    })
    .join('\n');
  const systemText = contentToText(body.system);
  return Math.max(1, estimateTokens(`${systemText}\n${messageText}`));
}

export function estimateResponsesPromptTokens(body: Record<string, unknown>): number {
  let totalChars = 0;

  if (typeof body.instructions === 'string') {
    totalChars += body.instructions.length;
  }

  const input = body.input;
  if (typeof input === 'string') {
    totalChars += input.length;
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        totalChars += item.length;
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.content === 'string') {
          totalChars += obj.content.length;
        } else if (Array.isArray(obj.content)) {
          for (const part of obj.content) {
            if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
              totalChars += (part as { text: string }).text.length;
            }
          }
        }
      }
    }
  }

  return Math.max(1, Math.ceil(totalChars / CHARS_PER_TOKEN));
}

/** Embeddings: every input string/sentence counts toward the prompt. */
export function estimateEmbeddingsPromptTokens(body: Record<string, unknown>): number {
  const input = body.input;
  let totalChars = 0;
  if (typeof input === 'string') {
    totalChars = input.length;
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        totalChars += item.length;
      } else if (Array.isArray(item)) {
        // Pre-tokenised input: numbers, not characters — approximate 1 token each.
        totalChars += item.length * CHARS_PER_TOKEN;
      }
    }
  }
  return Math.max(1, Math.ceil(totalChars / CHARS_PER_TOKEN));
}

/** Rerank: the query plus every document is read by the model. */
export function estimateRerankPromptTokens(body: Record<string, unknown>): number {
  const query = typeof body.query === 'string' ? body.query : '';
  const documents = Array.isArray(body.documents) ? body.documents : [];
  let totalChars = query.length;
  for (const doc of documents) {
    if (typeof doc === 'string') {
      totalChars += doc.length;
    } else if (doc && typeof doc === 'object' && typeof (doc as { text?: unknown }).text === 'string') {
      totalChars += (doc as { text: string }).text.length;
    }
  }
  return Math.max(1, Math.ceil(totalChars / CHARS_PER_TOKEN));
}

/**
 * System One has no messages[] — its prompt is `state` plus the `questions`
 * rubric, both of which are plain JSON. Counting the serialized body is the
 * closest local proxy when the upstream omits usage.
 */
export function estimateSystemOnePromptTokens(body: Record<string, unknown>): number {
  let totalChars = 0;
  for (const field of ['state', 'questions']) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    totalChars += typeof value === 'string' ? value.length : JSON.stringify(value).length;
  }
  return Math.max(1, Math.ceil(totalChars / CHARS_PER_TOKEN));
}

export function estimatePromptTokensFor(estimate: string, body: Record<string, unknown>): number {
  switch (estimate) {
    case 'chat':
      return estimateChatPromptTokens(body);
    case 'messages':
      return estimateAnthropicPromptTokens(body);
    case 'responses':
      return estimateResponsesPromptTokens(body);
    case 'embeddings':
      return estimateEmbeddingsPromptTokens(body);
    case 'rerank':
      return estimateRerankPromptTokens(body);
    case 'systemone':
      return estimateSystemOnePromptTokens(body);
    default:
      return 0;
  }
}

export { estimateTokens };
