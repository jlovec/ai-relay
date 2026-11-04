// ============================================================
// AI API Relay — SSE stream wrappers
//
// One wrapper pair per (client framing, upstream framing) combination, plus a
// cheap byte-counting passthrough for Cloudflare. The route handler selects a
// wrapper from the EndpointSpec instead of every route carrying its own copy.
//
// Each wrapper reports usage through an `onUsage` callback so the recording
// policy (batch recorder, request log, storage backend) lives in one place.
// ============================================================

import {
  chunkHasUsage,
  jsonStringFieldLength,
  createByteCountingStream,
  estimateCompletionTokensFromStreamBytes,
} from '@/lib/usage/stream-usage';
import { mapAnthropicStopReasonToOpenAI } from '@/lib/relay/transform';

export type UsageReporter = (promptTokens: number, completionTokens: number) => Promise<void>;

const CHARS_PER_TOKEN = 4;

function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Pass an OpenAI-chat or Anthropic SSE stream through unchanged, extracting
 * usage for accounting. `upstreamIsAnthropic` only selects which JSON field
 * carries the delta text when usage is missing and must be estimated.
 */
export function wrapSseStreamWithUsageTracking(
  upstreamBody: ReadableStream<Uint8Array>,
  upstreamIsAnthropic: boolean,
  requestPromptTokens: number,
  onUsage: UsageReporter
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  let accumulatedContentChars = 0;
  let recorded = false;

  async function recordUsage(promptTokens: number, completionTokens: number): Promise<void> {
    if (recorded) return;
    recorded = true;
    await onUsage(promptTokens, completionTokens);
  }

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (lastUsage) {
          await recordUsage(lastUsage.prompt_tokens || 0, lastUsage.completion_tokens || 0);
        } else if (accumulatedContentChars > 0) {
          await recordUsage(requestPromptTokens, estimateTokensFromChars(accumulatedContentChars));
        }
        controller.close();
        return;
      }

      controller.enqueue(value);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') continue;

        // Fast path: usage only lives in chunks carrying a *_tokens field.
        if (!chunkHasUsage(data)) {
          if (lastUsage) continue;
          accumulatedContentChars += jsonStringFieldLength(data, upstreamIsAnthropic ? 'text' : 'content');
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) lastUsage = parsed.usage;
          if (upstreamIsAnthropic && parsed.type === 'message_delta' && parsed.usage) {
            lastUsage = {
              prompt_tokens: parsed.usage.input_tokens || 0,
              completion_tokens: parsed.usage.output_tokens || 0,
            };
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

/**
 * Translate an Anthropic SSE stream into OpenAI chat-completion SSE, keeping
 * OpenAI-compatible clients insulated from an Anthropic-format upstream.
 */
export function wrapAnthropicStreamToOpenAIChat(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  requestPromptTokens: number,
  onUsage: UsageReporter
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let responseId = `chatcmpl_${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let recorded = false;
  let inputTokensFromUsage: number | null = null;
  let outputTokensFromUsage: number | null = null;
  let accumulatedContentChars = 0;
  let finalFinishReason: string | null = null;
  const toolBlocks = new Map<number, { toolCallIndex: number; id: string; name: string }>();
  let nextToolCallIndex = 0;

  function recordUsage(promptTokens: number, completionTokens: number): Promise<void> {
    if (recorded) return Promise.resolve();
    recorded = true;
    return onUsage(promptTokens, completionTokens);
  }

  function chunk(delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, number>): Uint8Array {
    const payload: Record<string, unknown> = {
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) payload.usage = usage;
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function ensureRole(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (sentRole) return;
    sentRole = true;
    controller.enqueue(chunk({ role: 'assistant' }));
  }

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const finalPromptTokens = inputTokensFromUsage ?? requestPromptTokens;
            const finalCompletionTokens = outputTokensFromUsage ?? estimateTokensFromChars(accumulatedContentChars);
            try {
              await recordUsage(finalPromptTokens, finalCompletionTokens);
            } catch (error) {
              console.error('[Usage] anthropic-to-openai stream recordUsage failed:', error);
            }
            ensureRole(controller);
            controller.enqueue(chunk({}, finalFinishReason || 'stop', {
              prompt_tokens: finalPromptTokens,
              completion_tokens: finalCompletionTokens,
              total_tokens: finalPromptTokens + finalCompletionTokens,
            }));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);

              if (parsed.type === 'message_start' && parsed.message) {
                if (parsed.message.id) responseId = parsed.message.id;
                if (parsed.message.usage?.input_tokens !== undefined) {
                  inputTokensFromUsage = parsed.message.usage.input_tokens;
                }
                ensureRole(controller);
                continue;
              }

              if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
                ensureRole(controller);
                const toolCallIndex = nextToolCallIndex++;
                const id = parsed.content_block.id || `call_${Date.now().toString(36)}_${toolCallIndex}`;
                const name = parsed.content_block.name || '';
                toolBlocks.set(parsed.index, { toolCallIndex, id, name });
                controller.enqueue(chunk({
                  tool_calls: [{
                    index: toolCallIndex,
                    id,
                    type: 'function',
                    function: { name, arguments: '' },
                  }],
                }));
                continue;
              }

              if (parsed.type === 'content_block_delta' && parsed.delta) {
                ensureRole(controller);
                if (parsed.delta.type === 'text_delta') {
                  const text = parsed.delta.text || '';
                  accumulatedContentChars += text.length;
                  controller.enqueue(chunk({ content: text }));
                } else if (parsed.delta.type === 'input_json_delta') {
                  const block = toolBlocks.get(parsed.index);
                  if (block) {
                    const partial = parsed.delta.partial_json || '';
                    accumulatedContentChars += partial.length;
                    controller.enqueue(chunk({
                      tool_calls: [{ index: block.toolCallIndex, function: { arguments: partial } }],
                    }));
                  }
                }
                continue;
              }

              if (parsed.type === 'message_delta') {
                finalFinishReason = mapAnthropicStopReasonToOpenAI(parsed.delta?.stop_reason);
                if (parsed.usage?.output_tokens !== undefined) {
                  outputTokensFromUsage = parsed.usage.output_tokens;
                }
              }
            } catch {
              // Ignore malformed SSE payloads and continue streaming valid chunks.
            }
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

/**
 * Translate an OpenAI chat-completion SSE stream into Anthropic Messages SSE.
 */
export function wrapOpenAIChatStreamToAnthropic(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  requestPromptTokens: number,
  onUsage: UsageReporter
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let messageId = `msg_${Date.now().toString(36)}`;
  let hasSentStart = false;
  let accumulatedCompletionTokens = 0;
  let recorded = false;
  let lastFinishReason: string | null = null;
  const promptTokens = requestPromptTokens;
  let inputTokensFromUsage: number | null = null;
  let outputTokensFromUsage: number | null = null;

  // Anthropic content blocks are addressed by a monotonic index. A text block
  // (if any) occupies the lowest indices; each OpenAI tool_call becomes its own
  // tool_use block. Track which blocks are open so we can emit the matching
  // content_block_stop before moving on / finishing.
  let nextBlockIndex = 0;
  let textBlockIndex: number | null = null;
  let textBlockOpen = false;
  // OpenAI streams tool_calls keyed by their own `index`; map that to our
  // Anthropic block index and remember whether the block is still open.
  const toolBlocks = new Map<number, { blockIndex: number; open: boolean }>();

  function recordUsage(pTokens: number, cTokens: number): Promise<void> {
    if (recorded) return Promise.resolve();
    recorded = true;
    return onUsage(pTokens, cTokens);
  }

  function formatSseEvent(event: Record<string, unknown>): Uint8Array {
    return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  return new ReadableStream({
    async start(controller) {
      function ensureStarted() {
        if (hasSentStart) return;
        hasSentStart = true;
        controller.enqueue(formatSseEvent({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: inputTokensFromUsage ?? promptTokens,
              output_tokens: 0,
            },
          },
        }));
        controller.enqueue(formatSseEvent({ type: 'ping' }));
      }

      function closeTextBlock() {
        if (textBlockOpen && textBlockIndex !== null) {
          controller.enqueue(formatSseEvent({ type: 'content_block_stop', index: textBlockIndex }));
          textBlockOpen = false;
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!hasSentStart) ensureStarted();

            if (hasSentStart) {
              closeTextBlock();
              for (const tb of toolBlocks.values()) {
                if (tb.open) {
                  controller.enqueue(formatSseEvent({ type: 'content_block_stop', index: tb.blockIndex }));
                  tb.open = false;
                }
              }

              const stopReasonMap: Record<string, string> = {
                stop: 'end_turn',
                length: 'max_tokens',
                tool_calls: 'tool_use',
                content_filter: 'stop_sequence',
              };
              const stopReason = lastFinishReason ? (stopReasonMap[lastFinishReason] || 'end_turn') : 'end_turn';

              const finalPromptTokens = inputTokensFromUsage ?? promptTokens;
              const finalCompletionTokens = outputTokensFromUsage ?? accumulatedCompletionTokens;

              controller.enqueue(formatSseEvent({
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: finalCompletionTokens },
              }));

              controller.enqueue(formatSseEvent({ type: 'message_stop' }));

              try {
                await recordUsage(finalPromptTokens, finalCompletionTokens);
              } catch (error) {
                console.error('[Usage] translate stream recordUsage failed:', error);
              }
            }
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              if (parsed.id) messageId = parsed.id;

              if (parsed.usage) {
                if (typeof parsed.usage.prompt_tokens === 'number') {
                  inputTokensFromUsage = parsed.usage.prompt_tokens;
                }
                if (typeof parsed.usage.completion_tokens === 'number') {
                  outputTokensFromUsage = parsed.usage.completion_tokens;
                }
              }

              const choice = parsed.choices?.[0];
              if (!choice) continue;

              if (choice.finish_reason) lastFinishReason = choice.finish_reason;

              const delta = choice.delta || {};
              const content: string = delta.content || '';

              if (content) {
                ensureStarted();
                if (textBlockIndex === null) textBlockIndex = nextBlockIndex++;
                if (!textBlockOpen) {
                  textBlockOpen = true;
                  controller.enqueue(formatSseEvent({
                    type: 'content_block_start',
                    index: textBlockIndex,
                    content_block: { type: 'text', text: '' },
                  }));
                }
                accumulatedCompletionTokens += estimateTokens(content);
                controller.enqueue(formatSseEvent({
                  type: 'content_block_delta',
                  index: textBlockIndex,
                  delta: { type: 'text_delta', text: content },
                }));
              }

              if (Array.isArray(delta.tool_calls)) {
                ensureStarted();
                for (const tc of delta.tool_calls) {
                  const oaIndex = typeof tc.index === 'number' ? tc.index : 0;
                  let block = toolBlocks.get(oaIndex);

                  if (!block) {
                    closeTextBlock();
                    const blockIndex = nextBlockIndex++;
                    block = { blockIndex, open: true };
                    toolBlocks.set(oaIndex, block);
                    controller.enqueue(formatSseEvent({
                      type: 'content_block_start',
                      index: blockIndex,
                      content_block: {
                        type: 'tool_use',
                        id: tc.id || `toolu_${Date.now().toString(36)}_${oaIndex}`,
                        name: tc.function?.name || '',
                        input: {},
                      },
                    }));
                  }

                  const argChunk: string = tc.function?.arguments || '';
                  if (argChunk) {
                    accumulatedCompletionTokens += estimateTokens(argChunk);
                    controller.enqueue(formatSseEvent({
                      type: 'content_block_delta',
                      index: block.blockIndex,
                      delta: { type: 'input_json_delta', partial_json: argChunk },
                    }));
                  }
                }
              }
            } catch {
              // Ignore non-JSON SSE payloads.
            }
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

/**
 * Pass an Anthropic Messages SSE stream through unchanged while tracking usage.
 */
export function wrapAnthropicStreamWithUsageTracking(
  upstreamBody: ReadableStream<Uint8Array>,
  requestPromptTokens: number,
  onUsage: UsageReporter
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedContentChars = 0;
  let lastUsage: { input_tokens?: number; output_tokens?: number } | null = null;
  let recorded = false;

  function recordUsage(promptTokens: number, completionTokens: number): Promise<void> {
    if (recorded) return Promise.resolve();
    recorded = true;
    return onUsage(promptTokens, completionTokens);
  }

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        try {
          if (lastUsage) {
            await recordUsage(lastUsage.input_tokens ?? requestPromptTokens, lastUsage.output_tokens ?? 0);
          } else if (accumulatedContentChars > 0) {
            await recordUsage(requestPromptTokens, estimateTokensFromChars(accumulatedContentChars));
          }
        } catch (error) {
          console.error('[Usage] anthropic stream recordUsage failed:', error);
        }
        controller.close();
        return;
      }

      controller.enqueue(value);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);

        // Fast path: skip JSON.parse for content_block_delta chunks. Usage lives
        // only in message_start / message_delta, which carry a *_tokens field.
        if (!chunkHasUsage(data)) {
          if (!lastUsage?.output_tokens) {
            accumulatedContentChars += jsonStringFieldLength(data, 'text');
          }
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'message_start' && parsed.message?.usage) {
            lastUsage = {
              input_tokens: parsed.message.usage.input_tokens,
              output_tokens: parsed.message.usage.output_tokens,
            };
          }
          if (parsed.type === 'message_delta' && parsed.usage) {
            lastUsage = {
              input_tokens: lastUsage?.input_tokens,
              output_tokens: parsed.usage.output_tokens,
            };
          }
        } catch {
          // Ignore non-JSON SSE payloads.
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

/**
 * Pass a Responses API SSE stream through unchanged while tracking usage.
 */
export function wrapResponsesStreamWithUsageTracking(
  upstreamBody: ReadableStream<Uint8Array>,
  requestPromptTokens: number,
  onUsage: UsageReporter
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } | null = null;
  let accumulatedContentChars = 0;
  let recorded = false;

  async function recordUsage(promptTokens: number, completionTokens: number): Promise<void> {
    if (recorded) return;
    recorded = true;
    await onUsage(promptTokens, completionTokens);
  }

  return new ReadableStream({
    async pull(controller) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (error) {
        controller.error(error);
        return;
      }

      if (done) {
        const flushed = decoder.decode();
        if (flushed) buffer += flushed;
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6).trim();
            if (data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data);
                if (parsed.usage) lastUsage = parsed.usage;
                if (parsed.type === 'response.completed' && parsed.response?.usage) {
                  lastUsage = parsed.response.usage;
                }
              } catch { /* not valid JSON */ }
            }
          }
        }

        try {
          if (lastUsage) {
            const prompt = lastUsage.prompt_tokens ?? lastUsage.input_tokens ?? requestPromptTokens;
            const completion = lastUsage.completion_tokens ?? lastUsage.output_tokens ?? 0;
            await recordUsage(prompt, completion);
          } else if (accumulatedContentChars > 0) {
            await recordUsage(requestPromptTokens, estimateTokensFromChars(accumulatedContentChars));
          }
        } catch (e) {
          console.error('[Usage] streaming recordUsage failed:', e);
        }
        controller.close();
        return;
      }

      controller.enqueue(value);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') continue;

        if (!chunkHasUsage(data)) {
          if (!lastUsage) accumulatedContentChars += jsonStringFieldLength(data, 'delta');
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) lastUsage = parsed.usage;
          if (parsed.type === 'response.completed' && parsed.response?.usage) {
            lastUsage = parsed.response.usage;
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

export { createByteCountingStream, estimateCompletionTokensFromStreamBytes };
