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

// How long the upstream may go silent before this serializer emits a keep-alive
// — the same 10s the OpenAI byte path uses (pipeline/streaming.ts's
// HEARTBEAT_MS). The native path had NO keep-alive at all, so a long prefill or
// a slow thinking block between parts left the connection byte-silent; the
// kortix.com Cloudflare zone gives up at `proxy_read_timeout = 125` seconds and
// serves a 524, which OpenCode >= 1.18.14 then matches with
// /429|500|502|503|504|524/ and retries FIVE times, re-sending the whole prompt
// each time.
const HEARTBEAT_MS = 10_000;
// An SSE COMMENT line, not a frame. `eventsource-parser` (which every AI SDK
// client reaches through `parseJsonEventStream` →
// `new EventSourceParserStream()`) returns early on a leading ':' and only
// surfaces the line when an `onComment` callback was supplied — the AI SDK
// supplies none. So this is invisible to the client parser and can never be
// mistaken for content, while still resetting every intermediate hop's idle
// timer. A fresh array per emit: enqueued buffers belong to the stream.
function heartbeatFrame(): Uint8Array {
  return enc.encode(': keep-alive\n\n');
}

// A streamText `fullStream` part (TextStreamPart union). The parts are typed at
// the SDK, but this gateway only depends on `.type` + a few string fields, so it
// carries the minimal open shape the serializer/probe read.
export type FullStreamPart = { type: string; [k: string]: unknown };

// The typed analog of usage/completion-guard.ts's `partHasContent`. A part is
// "content" — real assistant output the client would see — when it is:
//   - a `text-delta` or `reasoning-delta` carrying a NON-EMPTY `text` (an
//     empty-text delta is not content, exactly like partHasContent requires
//     `content.length > 0`);
//   - a `tool-call` (a fully-assembled call) or a `tool-input-start` (the model
//     has committed to calling a tool — the streaming analog of a populated
//     `tool_calls`).
// Everything else (`start`, `start-step`, `text-start`, `reasoning-start`,
// `finish`, `finish-step`, `response-metadata`, `raw`, ...) is framing, not
// content. The native failover path (pipeline/native-failover.ts) commits a
// candidate the instant this returns true — the moment real output exists,
// switching candidates is no longer allowed (same invariant as the byte path).
export function fullStreamPartHasContent(part: FullStreamPart): boolean {
  switch (part.type) {
    case 'text-delta': {
      const text = part.text;
      return typeof text === 'string' && text.length > 0;
    }
    case 'reasoning':
    case 'reasoning-start':
    case 'reasoning-delta': {
      const text = part.text;
      if (typeof text === 'string' && text.length > 0) return true;
      // A redacted/signature-only thinking turn (Anthropic) emits an empty-text
      // reasoning part whose providerMetadata carries the reasoning `signature`
      // or `redactedData`. That IS real assistant output — count it as content so
      // the failover probe does not misclassify the turn as empty and
      // retry/fail it over incorrectly.
      return reasoningMetadataHasContent(part.providerMetadata);
    }
    case 'tool-call':
    case 'tool-input-start':
      return true;
    default:
      return false;
  }
}

// True when a reasoning part's providerMetadata carries a non-empty Anthropic
// reasoning `signature` (normal thinking) or `redactedData` (redacted thinking).
// Either proves the model produced reasoning output even when the streamed text
// is empty.
function reasoningMetadataHasContent(pm: unknown): boolean {
  if (!pm || typeof pm !== 'object') return false;
  for (const providerEntry of Object.values(pm as Record<string, unknown>)) {
    if (!providerEntry || typeof providerEntry !== 'object') continue;
    const meta = providerEntry as Record<string, unknown>;
    if (
      (typeof meta.signature === 'string' && meta.signature.length > 0) ||
      (typeof meta.redactedData === 'string' && meta.redactedData.length > 0)
    ) {
      return true;
    }
  }
  return false;
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
  fullStream: AsyncIterable<FullStreamPart>,
  ctx: NativeStreamCtx,
  opts: {
    onUsage?: (usage: NativeBillingUsage) => void;
    // Invoked from `cancel()` IFF the stream is cancelled (client disconnect)
    // BEFORE any usage was reported — i.e. `onUsage` never fired and never will.
    // The pipeline uses this to refund an admission hold. Mutually exclusive with
    // `onUsage`: whichever runs first flips `usageReported`, so a cancelled turn
    // refunds and a completed turn bills, never both.
    onCancelWithoutUsage?: () => void;
    includeRawChunks?: boolean;
    /** Keep-alive interval in ms. `0` disables it. Overridable for tests. */
    heartbeatMs?: number;
  } = {},
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

      // Pull the next part, emitting an SSE keep-alive comment for every
      // `heartbeatMs` the upstream stays silent. Purely additive to the wire:
      // comments carry no event and no data, so the emitted PROTOCOL is
      // unchanged (see heartbeatFrame). The timer is always cleared before the
      // part is handled, so a fast stream emits none at all.
      const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
      const nextPart = async (): Promise<IteratorResult<FullStreamPart>> => {
        const pending = iterator.next();
        if (heartbeatMs <= 0) return pending;
        const timer = setInterval(() => emit(heartbeatFrame()), heartbeatMs);
        try {
          return await pending;
        } finally {
          clearInterval(timer);
        }
      };

      // `stream-start` opens every AI-gateway stream — the client waits for it
      // before reading parts, and `warnings` is a required field. Emit it EXACTLY
      // ONCE: the model's warnings arrive on the first `start-step` part, so defer
      // the emission until then (or until the first content part / stream end if
      // no `start-step` arrives) rather than emitting an empty one up front and a
      // second warnings-carrying one on `start-step`.
      let streamStartEmitted = false;
      const emitStreamStart = (warnings: unknown[]): void => {
        if (streamStartEmitted) return;
        streamStartEmitted = true;
        emit(frame({ type: 'stream-start', warnings }));
      };

      // Fallback usage: `finish-step` carries per-step usage; `finish` carries
      // the authoritative `totalUsage`. Keep the last seen so a stream that ends
      // without a `finish` (aborted) still bills whatever the provider reported.
      let lastStepUsage: LanguageModelUsage | undefined;

      try {
        for (;;) {
          const next = await nextPart();
          if (next.done) break;
          const part = next.value;
          const pm = part.providerMetadata as ProviderMetadata | undefined;
          // Guarantee `stream-start` precedes any content part even when the
          // provider skips `start-step` — it is a no-op once already emitted.
          if (part.type !== 'start' && part.type !== 'start-step') emitStreamStart([]);
          switch (part.type) {
            case 'start':
              break;
            case 'start-step': {
              const warnings = Array.isArray(part.warnings) ? part.warnings : [];
              emitStreamStart(warnings);
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

      // A stream that produced nothing (immediate done, or only a `start`) still
      // owes the client the opening frame before `[DONE]`.
      emitStreamStart([]);

      // Ensure billing sees SOME usage even if the stream never produced a
      // `finish` (aborted mid-flight) — reportUsage is idempotent.
      if (!usageReported) reportUsage(lastStepUsage);

      if (cancelled) return;
      emit(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
    async cancel(reason) {
      cancelled = true;
      // The consumer disconnected. If no usage was reported yet, `onUsage` will
      // never fire for this turn — invoke the refund path exactly once and latch
      // `usageReported` so the drain at line ~388 cannot also settle (bill) it.
      if (!usageReported) {
        usageReported = true;
        opts.onCancelWithoutUsage?.();
      }
      await iterator.return?.(reason);
    },
  });
}
