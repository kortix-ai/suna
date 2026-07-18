import type { FinishReason, LanguageModelUsage, ProviderMetadata } from 'ai';
import { looksLikeTerminalAuthFailure } from '../../errors';

// Adapts the AI SDK's provider-neutral stream/result back into the OpenAI
// chat.completions SSE + JSON shapes the gateway pipeline (probe, relay, usage
// extraction, billing, trace) and opencode both depend on. THIS is the contract
// boundary — the bytes produced here must be byte-compatible with what the native
// openai-compat transport emits, so nothing downstream can tell the paths apart.

const enc = new TextEncoder();

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
  cost?: number;
}

// Best-effort scan of AI-SDK provider metadata for a `cost` field under any
// provider namespace (currently only OpenRouter's — see model.ts's
// openRouterCostMetadataExtractor — written generically so a future
// provider-specific cost source needs no change here). `providerMetadata` is
// keyed by provider name (e.g. `{openrouterCost: {cost: 0.00012}}`); scan all
// namespaces rather than hardcoding the key so this keeps working if the
// namespace name ever changes on the model.ts side.
function costFromProviderMetadata(metadata: ProviderMetadata | undefined): number | undefined {
  if (!metadata) return undefined;
  for (const namespace of Object.values(metadata)) {
    const cost = (namespace as { cost?: unknown } | undefined)?.cost;
    if (typeof cost === 'number' && cost > 0) return cost;
  }
  return undefined;
}

// LanguageModelUsage → OpenAI `usage`. `inputTokens` is the full prompt count
// (cached included), matching OpenAI's `prompt_tokens`; the cached subset is
// broken out under `prompt_tokens_details.cached_tokens` exactly as the native
// path forwards it, so the gateway's usage extractor + pricing table produce the
// same cost on both engines. `cost`, when present, is the real upstream-billed
// dollar figure (e.g. OpenRouter's `usage.cost`) — the gateway's cost-hint
// extractor (usage/extract.ts normalizeUsageChunk) reads it as
// `upstreamCostHint` and pricing.ts prefers it whenever no catalog price is
// available, so a managed model with no models.dev price still bills real
// cost instead of $0 (defect 3, 2026-07-17).
export function mapUsage(
  usage: LanguageModelUsage | undefined,
  providerMetadata?: ProviderMetadata,
): OpenAiUsage {
  const prompt = usage?.inputTokens ?? 0;
  const completion = usage?.outputTokens ?? 0;
  const cached = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const reasoning = usage?.outputTokenDetails?.reasoningTokens ?? 0;
  const total = usage?.totalTokens ?? prompt + completion;
  const out: OpenAiUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
  if (cached > 0) out.prompt_tokens_details = { cached_tokens: cached };
  if (reasoning > 0) out.completion_tokens_details = { reasoning_tokens: reasoning };
  const cost = costFromProviderMetadata(providerMetadata);
  if (cost !== undefined) out.cost = cost;
  return out;
}

export function mapFinishReason(reason: FinishReason | undefined): string {
  switch (reason) {
    case 'tool-calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    case 'stop':
      return 'stop';
    default:
      return 'stop';
  }
}

function chatId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function sse(obj: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

interface StreamCtx {
  model: string;
  provider: string;
}

// AI SDK `fullStream` (TextStreamPart union) → OpenAI chat.completions SSE.
export function openAiSseFromFullStream(
  fullStream: AsyncIterable<{ type: string; [k: string]: unknown }>,
  ctx: StreamCtx,
): ReadableStream<Uint8Array> {
  const id = chatId();
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model: ctx.model };

  // Map AI SDK tool-call ids → dense OpenAI tool_call indices, and remember which
  // ids already opened a streamed call so a terminal `tool-call` part for the same
  // id doesn't re-emit the name/arguments.
  const toolIndex = new Map<string, number>();
  let nextToolIndex = 0;
  const streamedTools = new Set<string>();
  let roleSent = false;

  const delta = (d: Record<string, unknown>, finishReason: string | null = null): Uint8Array =>
    sse({ ...base, choices: [{ index: 0, delta: d, finish_reason: finishReason }] });

  // Grabbed ONCE and shared between `start()`'s consumption loop and
  // `cancel()` below — `for await...of` on `fullStream` directly would call
  // `fullStream[Symbol.asyncIterator]()` internally too, but a SEPARATE call
  // to it from `cancel()` would hand back a different, independent iterator
  // for most async-iterable implementations (including a ReadableStream-
  // backed one, which typically mints a fresh reader per
  // `getReader()`/iterator call) — cancelling THAT one would do nothing to
  // the one `start()` is actually still awaiting.
  const iterator = fullStream[Symbol.asyncIterator]();
  // Set by `cancel()` (the downstream/client side gave up) — once true, the
  // controller is no longer writable (enqueue/close on an already-cancelled
  // ReadableStream throws), so the rest of `start()`'s loop and its terminal
  // finish/usage/[DONE] frames below must become no-ops instead of crashing.
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (bytes: Uint8Array): void => {
        if (!cancelled) controller.enqueue(bytes);
      };
      let usage: LanguageModelUsage | undefined;
      let finishReason: FinishReason | undefined;
      // Cost (when present) only ever arrives on `finish-step` — the `finish`
      // part carries totalUsage but no providerMetadata of its own. The
      // gateway's tool loop is always single-step per call (see model.ts's
      // `toToolSet` — no `execute`, so the SDK stops after the tool call
      // instead of continuing to a second step), so the last `finish-step`
      // seen is the authoritative one, same as `usage`/`finishReason` above.
      let providerMetadata: ProviderMetadata | undefined;
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          const part = next.value;
          switch (part.type) {
            case 'text-delta': {
              if (!roleSent) {
                emit(delta({ role: 'assistant', content: '' }));
                roleSent = true;
              }
              const text = part.text as string;
              if (text) emit(delta({ content: text }));
              break;
            }
            case 'reasoning-delta': {
              if (!roleSent) {
                emit(delta({ role: 'assistant', content: '' }));
                roleSent = true;
              }
              const text = part.text as string;
              if (text) emit(delta({ reasoning: text }));
              break;
            }
            case 'tool-input-start': {
              if (!roleSent) {
                emit(delta({ role: 'assistant', content: '' }));
                roleSent = true;
              }
              const tid = part.id as string;
              const index = nextToolIndex++;
              toolIndex.set(tid, index);
              streamedTools.add(tid);
              emit(
                delta({
                  tool_calls: [
                    {
                      index,
                      id: tid,
                      type: 'function',
                      function: { name: part.toolName as string, arguments: '' },
                    },
                  ],
                }),
              );
              break;
            }
            case 'tool-input-delta': {
              const tid = part.id as string;
              const index = toolIndex.get(tid);
              if (index === undefined) break;
              emit(
                delta({
                  tool_calls: [{ index, function: { arguments: (part.delta as string) ?? '' } }],
                }),
              );
              break;
            }
            case 'tool-call': {
              const tid = part.toolCallId as string;
              if (streamedTools.has(tid)) break; // already streamed via input-start/delta
              if (!roleSent) {
                emit(delta({ role: 'assistant', content: '' }));
                roleSent = true;
              }
              const index = nextToolIndex++;
              emit(
                delta({
                  tool_calls: [
                    {
                      index,
                      id: tid,
                      type: 'function',
                      function: {
                        name: part.toolName as string,
                        arguments: JSON.stringify(part.input ?? {}),
                      },
                    },
                  ],
                }),
              );
              break;
            }
            case 'finish': {
              usage = part.totalUsage as LanguageModelUsage;
              finishReason = part.finishReason as FinishReason;
              break;
            }
            case 'finish-step': {
              if (!usage) usage = part.usage as LanguageModelUsage;
              if (!finishReason) finishReason = part.finishReason as FinishReason;
              providerMetadata = part.providerMetadata as ProviderMetadata | undefined;
              break;
            }
            case 'error': {
              // A structured upstream failure (auth, overloaded, content filter).
              // Emit the OpenAI-shaped error frame the gateway probe detects so it
              // fails over / surfaces the real cause instead of a blank stop.
              const err = part.error;
              // `@ai-sdk/openai`/`@ai-sdk/openai-compatible`'s OWN in-band
              // streaming error frame (OpenAI's `data: {"error":{"message":...,
              // "type":...,"code":...}}` convention) is enqueued as a PLAIN
              // OBJECT, never an `Error` instance — `{message, type, param,
              // code}` straight from the parsed upstream JSON (see those
              // packages' chat-completions stream transform). Anthropic/Bedrock
              // provider errors, by contrast, ARE genuine `Error`/AISDKError
              // instances. Both shapes carry a `.message` string; check for that
              // structurally rather than assuming one specific class.
              const errObj =
                err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
              const message =
                err instanceof Error
                  ? err.message
                  : typeof err === 'string'
                    ? err
                    : typeof errObj?.message === 'string'
                      ? errObj.message
                      : 'Upstream error';
              // Some provider errors (AWS credential/SigV4 failures, an AI-SDK
              // error class without a `.statusCode`) never carry a numeric code —
              // fall back to classifying the message itself so a terminal auth
              // failure is still recognizable as one downstream, same as
              // toTransportError (index.ts) does for the non-streaming path.
              const rawCode = errObj?.statusCode ?? errObj?.code;
              const code =
                typeof rawCode === 'number' || typeof rawCode === 'string'
                  ? rawCode
                  : looksLikeTerminalAuthFailure(message)
                    ? 401
                    : undefined;
              emit(sse({ error: { message, ...(code != null ? { code } : {}) } }));
              break;
            }
            default:
              break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          (err as { statusCode?: number })?.statusCode ??
          (looksLikeTerminalAuthFailure(message) ? 401 : undefined);
        emit(sse({ error: { message, ...(code != null ? { code } : {}) } }));
      }

      // Terminal finish chunk + usage-only chunk (OpenAI include_usage semantics)
      // + [DONE]. The usage chunk carries `model` so the SSE usage extractor books
      // the right model even if no content chunk did. Skipped entirely once
      // cancelled — the controller is no longer writable, and there's no
      // client left to receive a synthetic finish/[DONE] anyway.
      if (cancelled) return;
      emit(delta({}, mapFinishReason(finishReason)));
      emit(
        sse({
          ...base,
          choices: [],
          usage: mapUsage(usage, providerMetadata),
        }),
      );
      emit(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
    // The downstream consumer (pipeline/streaming.ts's relayStream) cancels
    // its reader the moment the INBOUND client disconnects — without this
    // handler that cancellation was a no-op as far as the actual upstream
    // call was concerned: `start()`'s consumption loop kept running in the
    // background, silently draining (and paying for) tokens from a real
    // provider connection with no one left listening. Propagating the
    // cancellation onto the SAME iterator `start()` is awaiting (see the
    // shared `iterator` above) lets it unwind its underlying resource —
    // for the AI SDK's own ReadableStream-backed `fullStream`, that means
    // cancelling the reader on the actual upstream HTTP response body,
    // exactly like the retired native transport's direct
    // `upstreamBody.getReader().cancel()` did.
    async cancel(reason) {
      cancelled = true;
      await iterator.return?.(reason);
    },
  });
}

// generateText result → OpenAI chat.completion JSON (non-streaming).
export function openAiJsonFromResult(
  result: {
    text: string;
    reasoningText?: string;
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
    finishReason: FinishReason;
    usage: LanguageModelUsage;
    providerMetadata?: ProviderMetadata;
  },
  ctx: StreamCtx,
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: result.text ?? '' };
  if (result.reasoningText) message.reasoning = result.reasoningText;
  if (result.toolCalls && result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((tc) => ({
      id: tc.toolCallId,
      type: 'function',
      function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
    }));
    message.content = result.text || null;
  }
  return {
    id: chatId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: ctx.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(result.finishReason),
      },
    ],
    usage: mapUsage(result.usage, result.providerMetadata),
  };
}
