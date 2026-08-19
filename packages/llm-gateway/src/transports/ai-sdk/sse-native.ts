import type { FinishReason, LanguageModelUsage, ProviderMetadata } from 'ai';
import { looksLikeTerminalAuthFailure } from '../../errors';

// AI-SDK-NATIVE egress serializer.
//
// This is the LOSSLESS alternative to `openAiSseFromFullStream` (sse.ts). Where
// that function down-encodes the AI SDK `fullStream` into OpenAI
// chat.completions SSE — collapsing reasoning to a bare `delta.reasoning`
// string and THROWING AWAY the Anthropic reasoning `signature`/`redactedData`
// that live under `providerMetadata.anthropic` — this serializer emits the
// Vercel "AI Gateway" wire protocol: each frame is a JSON-serialized
// `LanguageModelV{3,4}StreamPart` the `@ai-sdk/gateway` client parses back with
// `z.any()` passthrough. `providerMetadata` rides through on every part, so the
// reasoning signature survives end to end.
//
// It consumes the SAME `result.fullStream` (streamText's `TextStreamPart`
// union) the existing OpenAI path already consumes — only the mapping target
// differs. Emit ONLY the v3∩v4 common parts (see the switch below); NEVER emit
// v4-only `custom` / `reasoning-file`.

const enc = new TextEncoder();

function frame(part: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(part)}\n\n`);
}

export interface NativeStreamCtx {
  model: string;
  provider: string;
}

// Billing counts extracted from the AI-gateway `finish` part. The pipeline reads
// `finish.usage.inputTokens.total` + `finish.usage.outputTokens.total` for the
// billed totals; the cache subsets are folded into the input total exactly like
// the OpenAI path (see usage/pricing.ts calculateCost), so a cache-heavy turn
// prices at the right rate.
export interface NativeBillingUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

// The AI-gateway wire `finish.usage` shape (see the wire contract). Built from
// the AI SDK `LanguageModelUsage` (ai@7 shape: inputTokens/outputTokens +
// inputTokenDetails{noCache,cacheRead,cacheWrite} + outputTokenDetails{text,
// reasoning}). Fields are emitted verbatim to the client and re-read for
// billing (see `billingUsageFromWire`).
export interface WireUsage {
  inputTokens: {
    total: number;
    noCache: number;
    cacheRead: number;
    cacheWrite: number;
  };
  outputTokens: {
    total: number;
    text: number;
    reasoning: number;
  };
}

export function wireUsageFromLanguageModelUsage(usage: LanguageModelUsage | undefined): WireUsage {
  const inputTotal = usage?.inputTokens ?? 0;
  const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  // Prefer the provider-reported non-cached count; fall back to deriving it from
  // the total so a provider that only reports the total still splits cleanly.
  const noCache =
    usage?.inputTokenDetails?.noCacheTokens ?? Math.max(0, inputTotal - cacheRead - cacheWrite);
  const outputTotal = usage?.outputTokens ?? 0;
  const reasoning = usage?.outputTokenDetails?.reasoningTokens ?? 0;
  const text = usage?.outputTokenDetails?.textTokens ?? Math.max(0, outputTotal - reasoning);
  return {
    inputTokens: { total: inputTotal, noCache, cacheRead, cacheWrite },
    outputTokens: { total: outputTotal, text, reasoning },
  };
}

// Wire `finish.usage` → the gateway's TokenCounts. `promptTokens` is the FULL
// input count (cache reads + writes included) so total_tokens back-compat holds
// and cache subsets can be re-priced — identical convention to sse.ts mapUsage.
export function billingUsageFromWire(usage: WireUsage): NativeBillingUsage {
  const promptTokens = usage.inputTokens.total;
  const completionTokens = usage.outputTokens.total;
  return {
    promptTokens,
    completionTokens,
    cachedTokens: usage.inputTokens.cacheRead,
    cacheWriteTokens: usage.inputTokens.cacheWrite,
    totalTokens: promptTokens + completionTokens,
  };
}

function mapFinishReason(reason: FinishReason | undefined): { unified: string; raw: string } {
  const unified = reason ?? 'stop';
  return { unified, raw: unified };
}

// Only pass `providerMetadata` through when it actually carries something — an
// empty object on every text-delta is wire noise the client does not need.
function withProviderMetadata<T extends Record<string, unknown>>(
  base: T,
  providerMetadata: ProviderMetadata | undefined,
): T {
  if (providerMetadata && Object.keys(providerMetadata).length > 0) {
    return { ...base, providerMetadata };
  }
  return base;
}

// streamText `fullStream` (TextStreamPart union) → AI-gateway SSE
// (LanguageModelV{3,4}StreamPart frames). `onUsage` fires once, when the
// terminal usage is known, so the pipeline can bill without re-parsing bytes.
export function aiGatewaySseFromFullStream(
  fullStream: AsyncIterable<{ type: string; [k: string]: unknown }>,
  ctx: NativeStreamCtx,
  opts: { onUsage?: (usage: NativeBillingUsage) => void; includeRawChunks?: boolean } = {},
): ReadableStream<Uint8Array> {
  const iterator = fullStream[Symbol.asyncIterator]();
  let cancelled = false;
  let usageReported = false;

  const reportUsage = (usage: LanguageModelUsage | undefined): WireUsage => {
    const wire = wireUsageFromLanguageModelUsage(usage);
    if (!usageReported) {
      usageReported = true;
      opts.onUsage?.(billingUsageFromWire(wire));
    }
    return wire;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (bytes: Uint8Array): void => {
        if (!cancelled) controller.enqueue(bytes);
      };

      // `stream-start` opens every AI-gateway stream — the client waits for it
      // before reading parts, and `warnings` is a required field (empty when the
      // model reports none; the first `start-step` part below fills it in).
      emit(frame({ type: 'stream-start', warnings: [] }));

      // Fallback usage: `finish-step` carries per-step usage; `finish` carries
      // the authoritative `totalUsage`. Keep the last seen so a stream that ends
      // without a `finish` (aborted) still bills whatever the provider reported.
      let lastStepUsage: LanguageModelUsage | undefined;

      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          const part = next.value;
          const pm = part.providerMetadata as ProviderMetadata | undefined;
          switch (part.type) {
            case 'start':
              break;
            case 'start-step': {
              const warnings = Array.isArray(part.warnings) ? part.warnings : [];
              if (warnings.length > 0) {
                emit(frame({ type: 'stream-start', warnings }));
              }
              break;
            }
            case 'text-start':
              emit(frame(withProviderMetadata({ type: 'text-start', id: part.id }, pm)));
              break;
            case 'text-delta':
              // Wire field is `delta`, never `textDelta`. Source is streamText's
              // `.text` on the fullStream part.
              emit(
                frame(
                  withProviderMetadata({ type: 'text-delta', id: part.id, delta: part.text }, pm),
                ),
              );
              break;
            case 'text-end':
              emit(frame(withProviderMetadata({ type: 'text-end', id: part.id }, pm)));
              break;
            case 'reasoning-start':
              emit(frame(withProviderMetadata({ type: 'reasoning-start', id: part.id }, pm)));
              break;
            case 'reasoning-delta':
              // providerMetadata carries the Anthropic signature/redactedData
              // (`providerMetadata.anthropic.signature`) — the whole reason this
              // serializer exists. Pass it through verbatim.
              emit(
                frame(
                  withProviderMetadata(
                    { type: 'reasoning-delta', id: part.id, delta: part.text },
                    pm,
                  ),
                ),
              );
              break;
            case 'reasoning-end':
              emit(frame(withProviderMetadata({ type: 'reasoning-end', id: part.id }, pm)));
              break;
            case 'tool-input-start':
              emit(
                frame(
                  withProviderMetadata(
                    { type: 'tool-input-start', id: part.id, toolName: part.toolName },
                    pm,
                  ),
                ),
              );
              break;
            case 'tool-input-delta':
              emit(
                frame(
                  withProviderMetadata(
                    { type: 'tool-input-delta', id: part.id, delta: part.delta },
                    pm,
                  ),
                ),
              );
              break;
            case 'tool-input-end':
              emit(frame(withProviderMetadata({ type: 'tool-input-end', id: part.id }, pm)));
              break;
            case 'tool-call': {
              // Wire `input` is a JSON STRING. streamText's fullStream tool-call
              // carries the already-parsed `input` object — stringify it (unless
              // a provider handed us a raw string already).
              const input =
                typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {});
              emit(
                frame(
                  withProviderMetadata(
                    {
                      type: 'tool-call',
                      toolCallId: part.toolCallId,
                      toolName: part.toolName,
                      input,
                    },
                    pm,
                  ),
                ),
              );
              break;
            }
            case 'tool-result':
              emit(
                frame(
                  withProviderMetadata(
                    {
                      type: 'tool-result',
                      toolCallId: part.toolCallId,
                      toolName: part.toolName,
                      result: part.output ?? part.result,
                    },
                    pm,
                  ),
                ),
              );
              break;
            case 'source':
              emit(frame(withProviderMetadata({ ...part, type: 'source' }, pm)));
              break;
            case 'file':
              emit(
                frame(
                  withProviderMetadata(
                    { type: 'file', mediaType: part.mediaType, data: part.data ?? part.file },
                    pm,
                  ),
                ),
              );
              break;
            case 'finish-step': {
              lastStepUsage = part.usage as LanguageModelUsage | undefined;
              const response = part.response as
                | { id?: string; modelId?: string; timestamp?: unknown }
                | undefined;
              if (response) {
                emit(
                  frame({
                    type: 'response-metadata',
                    ...(response.id !== undefined ? { id: response.id } : {}),
                    ...(response.modelId !== undefined ? { modelId: response.modelId } : {}),
                    ...(response.timestamp !== undefined ? { timestamp: response.timestamp } : {}),
                  }),
                );
              }
              break;
            }
            case 'finish': {
              const usage = (part.totalUsage ?? lastStepUsage) as LanguageModelUsage | undefined;
              const wire = reportUsage(usage);
              emit(
                frame(
                  withProviderMetadata(
                    {
                      type: 'finish',
                      finishReason: mapFinishReason(part.finishReason as FinishReason | undefined),
                      usage: wire,
                    },
                    pm,
                  ),
                ),
              );
              break;
            }
            case 'raw':
              if (opts.includeRawChunks) emit(frame({ ...part, type: 'raw' }));
              break;
            case 'abort':
              emit(frame({ type: 'error', error: { message: 'Stream aborted' } }));
              break;
            case 'error': {
              const err = part.error;
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
              const rawCode = errObj?.statusCode ?? errObj?.code;
              const code =
                typeof rawCode === 'number' || typeof rawCode === 'string'
                  ? rawCode
                  : looksLikeTerminalAuthFailure(message)
                    ? 401
                    : undefined;
              emit(
                frame({
                  type: 'error',
                  error: { message, ...(code != null ? { code } : {}) },
                }),
              );
              break;
            }
            // NEVER emit v4-only `custom` / `reasoning-file`, and drop any other
            // future part the client's common parser does not model.
            default:
              break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          (err as { statusCode?: number })?.statusCode ??
          (looksLikeTerminalAuthFailure(message) ? 401 : undefined);
        emit(frame({ type: 'error', error: { message, ...(code != null ? { code } : {}) } }));
      }

      // Ensure billing sees SOME usage even if the stream never produced a
      // `finish` (aborted mid-flight) — reportUsage is idempotent.
      if (!usageReported) reportUsage(lastStepUsage);

      if (cancelled) return;
      emit(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
    async cancel(reason) {
      cancelled = true;
      await iterator.return?.(reason);
    },
  });
}
