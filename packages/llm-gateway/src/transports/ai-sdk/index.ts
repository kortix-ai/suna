import { CATALOG, catalogModelForWireModel } from '@kortix/llm-catalog';
import { InvalidPromptError, generateText, streamText } from 'ai';
import type { UpstreamDescriptor } from '../../domain';
import { NetworkError, UpstreamHttpError, looksLikeTerminalAuthFailure } from '../../errors';
import {
  type AiSdkFetch,
  aiSdkFamilyFor,
  clampMaxOutputTokensForBedrock,
  isCodexDescriptor,
  resolveAiModel,
} from './model';
import { buildAiSdkArgs } from './request';
import { openAiJsonFromResult, openAiSseFromFullStream } from './sse';

export type { AiSdkFetch } from './model';
export {
  aiSdkFamilyFor,
  isAiSdkServable,
  isCodexDescriptor,
  needsResponsesApi,
  resolveAiModel,
} from './model';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// An upstream can return a syntactically valid 200 with `choices: []` — a
// genuinely EMPTY array, not merely an empty-content choice (see
// usage/completion-guard.ts's `jsonHasContent`, which explicitly treats both
// shapes the same way: "no real output, try the next candidate" — the
// OpenRouter/z-ai pattern pipeline/handler.ts's `registerEmptyCompletion`
// exists for, observed at a ~19% transient rate in production). Every
// chat-completions-family AI SDK provider package (openai, openai-compatible)
// unconditionally indexes `responseBody.choices[0]` and crashes with a raw
// TypeError if that index doesn't exist, turning this already-understood,
// already-handled upstream failure mode into an opaque thrown error that
// bypasses the gateway's own empty-completion retry/failover logic entirely
// — instead of flowing through as the syntactically valid (if unhelpfully
// empty) response it actually is. Patched at the fetch boundary EVERY
// chat-completions family's provider package ends up calling, so the fix
// applies regardless of which one `resolveAiModel` picked; a no-op for the
// Responses API (`output`, not `choices`) and Anthropic/Bedrock (their own
// wire shapes) — neither ever has a `choices` key to match — and for
// streaming responses (`content-type: text/event-stream`, never touched
// here; an empty stream is a separate problem streaming.ts's probe already
// handles on its own terms).
function guardEmptyChoicesFetch(fetch: AiSdkFetch): AiSdkFetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('json')) return response;
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    const choices = (data as { choices?: unknown } | undefined)?.choices;
    if (!Array.isArray(choices) || choices.length !== 0) {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    const patched = {
      ...(data as Record<string, unknown>),
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    };
    return new Response(JSON.stringify(patched), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

// Map an AI SDK error into the gateway's transport error taxonomy so failover,
// retry, and the circuit breaker behave identically to the native path.
//
// Defect (2026-07-17, live-confirmed): not every AI-SDK provider error carries
// a numeric `.statusCode` — an AWS credential/SigV4 resolution failure
// (Bedrock) can throw before any HTTP response ever exists, and some AI-SDK
// error classes don't expose one at all. Without the message-based fallback
// below, those errors always fell through to a generic NetworkError — which
// `defaultIsRetryable` treats as retryable — so an invalid/dead upstream key
// got retried into a permanently empty, hung session turn (11+ attempts over
// 2+ minutes, no error ever surfaced) instead of failing fast on attempt one.
export function toTransportError(err: unknown, provider: string): Error {
  // The AI SDK validates the built prompt CLIENT-SIDE, before any request
  // ever goes out (e.g. `messages` resolving to an empty array — a body with
  // no `messages` field at all, or a `messages: []`) — no native transport
  // ever had this check; it always forwarded whatever body it was given
  // straight to the upstream, which would itself 400 the malformed request.
  // Classified the same way a real upstream 400 would be here so it fails
  // fast in ONE attempt (defaultIsRetryable never retries a 400) instead of
  // falling through to the generic NetworkError case below, which IS
  // retryable and would otherwise burn the full retry budget on a request
  // that can never succeed no matter how many times it's replayed.
  if (InvalidPromptError.isInstance(err)) {
    return new UpstreamHttpError(400, err.message, provider);
  }
  const e = err as {
    statusCode?: number;
    responseBody?: string;
    message?: string;
    url?: string;
    cause?: { statusCode?: number };
  };
  // A `cause`-wrapped statusCode (some AI-SDK error classes nest the original
  // API-call error there) counts the same as a top-level one.
  const statusCode =
    typeof e?.statusCode === 'number'
      ? e.statusCode
      : typeof e?.cause?.statusCode === 'number'
        ? e.cause.statusCode
        : undefined;
  if (typeof statusCode === 'number') {
    return new UpstreamHttpError(statusCode, e.responseBody ?? e.message ?? '', provider);
  }
  const message = e?.message ?? (err instanceof Error ? err.message : String(err));
  if (looksLikeTerminalAuthFailure(message)) {
    return new UpstreamHttpError(401, message, provider);
  }
  return new NetworkError(`ai-sdk call to ${provider} failed`, err);
}

// `streamText`'s result exposes several lazily-computed promises (usage, text,
// finishReason, steps, toolCalls, ...) that resolve/reject as the SAME
// underlying stream `fullStream` drives progresses (ai's `DelayedPromise`:
// resolve/reject always update its internal status, and ALSO forward onto the
// real native Promise the instant one has been created by any earlier access
// — including one made internally by the SDK's own onFinish/telemetry
// plumbing, not just by our code). This transport only ever consumes
// `fullStream` (below) — nothing here ever awaits `result.usage` etc. — so if
// the upstream call fails mid-stream and something upstream of us ends up
// materializing one of these promises, its rejection has no attached handler:
// an unhandled promise rejection, which crashes the whole Bun worker process,
// dropping the connection as a bare Cloudflare 502 BEFORE the `error` part
// `openAiSseFromFullStream` (sse.ts) turns into a clean SSE error frame ever
// gets a chance to run, and before any settle/logging path in the pipeline
// runs — the real upstream error is lost, not surfaced. Attaching a no-op
// catch to every one of them makes a rejection here inert; the actual error
// the caller sees is still the `error` part sse.ts already handles correctly.
// Applies to every provider's streaming call, not just Anthropic's.
export function guardAgainstUnhandledResultRejections(result: {
  usage: PromiseLike<unknown>;
  text: PromiseLike<unknown>;
  finishReason: PromiseLike<unknown>;
  steps: PromiseLike<unknown>;
  toolCalls: PromiseLike<unknown>;
  finalStep: PromiseLike<unknown>;
  providerMetadata: PromiseLike<unknown>;
}): void {
  for (const p of [
    result.usage,
    result.text,
    result.finishReason,
    result.steps,
    result.toolCalls,
    result.finalStep,
    result.providerMetadata,
  ]) {
    void Promise.resolve(p).catch(() => {});
  }
}

// Both `generateText`'s and `streamText`'s settled results expose tool calls
// as an array of `{toolCallId, toolName, input}` (plus provider-specific
// fields we don't need) — normalize either into what openAiJsonFromResult
// wants, once, instead of duplicating the `.map` at both call sites below.
// Exported so ai-sdk.test.ts can drive the exact same collapse sequence
// callUpstreamViaAiSdk's Codex/non-streaming branch runs, against a real
// `streamText()` result from a mock model, without needing network access.
export function mapToolCalls(
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input?: unknown }> | undefined,
): Array<{ toolCallId: string; toolName: string; input: unknown }> | undefined {
  return toolCalls?.map((tc) => ({
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: tc.input,
  }));
}

// The AI-SDK transport engine. Given the same OpenAI chat.completions body and
// descriptor the native path receives, drive the AI SDK provider package and
// return a Response in the SAME OpenAI-compatible shape (SSE for stream, JSON
// otherwise) — so the pipeline, billing, and opencode see no difference.
//
// Streaming returns immediately (matching native): errors then surface as an
// in-stream OpenAI error frame the pipeline probe already handles. Non-streaming
// awaits the call so a 4xx/5xx throws here and drives the same failover.
export async function callUpstreamViaAiSdk(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  opts: { signal?: AbortSignal; fetch?: AiSdkFetch; requestId?: string } = {},
): Promise<Response> {
  const family = aiSdkFamilyFor(descriptor);
  const isCodex = isCodexDescriptor(descriptor);
  // `body` decides chat.completions vs Responses for the 'openai' family (see
  // model.ts's needsResponsesApi) — Codex/genuine-OpenAI-reasoning-with-tools
  // only, everything else keeps using .chat().
  const model = resolveAiModel(descriptor, body, {
    // Always wrapped — see guardEmptyChoicesFetch's doc comment — regardless
    // of whether the caller supplied its own fetchImpl (tests) or this falls
    // through to the platform default (production).
    fetch: guardEmptyChoicesFetch(opts.fetch ?? ((input, init) => globalThis.fetch(input, init))),
    // Kortix-internal correlation id, mirrored onto the upstream request as a
    // best-effort header — every provider here tolerates unknown headers.
    // This is the ai-sdk-engine equivalent of what the retired native
    // transport's `callUpstream` used to attach directly onto the built
    // request (see http/call-upstream.ts).
    extraHeaders: opts.requestId ? { 'x-kortix-request-id': opts.requestId } : undefined,
  });
  const args = buildAiSdkArgs(body, family, {
    // The ChatGPT Codex backend always expects a reasoning effort; the native
    // transport defaults to 'low' when the caller sends none (see
    // openai-responses/request.ts's `chatToResponses`) — mirrored here via
    // buildAiSdkArgs's opt-in default rather than in buildAiSdkArgs itself, so
    // every non-Codex caller's "no default effort" behavior is untouched.
    defaultReasoningEffort: isCodex ? 'low' : undefined,
    // Needed so buildAiSdkArgs keys providerOptions under the SAME name
    // model.ts passed to createOpenAICompatible for this descriptor — see
    // request.ts's providerOptionsKeyFor / defect 5 comment.
    providerName: descriptor.provider,
    // The resolved catalog model for the WIRE model id (managed slug, BYOK
    // `provider/id`, or `codex/id` — `catalogModelForWireModel` stitches all
    // three), so buildAiSdkArgs can gate reasoning_effort/temperature/top_p/
    // max_tokens against its real models.dev capabilities (see request.ts's
    // normalizeRequest). `undefined` for an unknown/unresolvable id → no gating
    // (permissive parity). Keyed off the client wire id, not descriptor
    // .resolvedModel (which is the UPSTREAM id — a Bedrock/OpenRouter slug that
    // wouldn't resolve here). The bundled static CATALOG is authoritative for
    // capability shape; the transport has no live snapshot.
    model: catalogModelForWireModel(String(body.model ?? ''), CATALOG),
  });
  const clientWantsStream = body.stream === true;
  const ctx = {
    model: descriptor.resolvedModel || String(body.model ?? ''),
    provider: descriptor.provider,
  };

  const shared = {
    model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    toolChoice: args.toolChoice,
    temperature: args.temperature,
    topP: args.topP,
    // Clamped for small Bedrock models (Nova) whose Converse API hard-rejects
    // an over-large ceiling instead of silently capping it — see model.ts's
    // clampMaxOutputTokensForBedrock. A no-op for every other family/model.
    maxOutputTokens: clampMaxOutputTokensForBedrock(
      args.maxOutputTokens,
      family,
      descriptor.resolvedModel,
    ),
    stopSequences: args.stopSequences,
    seed: args.seed,
    frequencyPenalty: args.frequencyPenalty,
    presencePenalty: args.presencePenalty,
    // Drives response_format (JSON mode / structured output) — see
    // request.ts's buildResponseFormatOutput. `undefined` here is exactly
    // streamText/generateText's own default (plain text), so a request with
    // no response_format is completely unaffected by this field existing.
    output: args.output,
    providerOptions: args.providerOptions,
    // The gateway owns retry/failover/circuit-breaking; keep the SDK from adding a
    // second, opaque retry layer on top.
    maxRetries: 0,
    abortSignal: opts.signal,
  } as const;

  // Codex's backend is stream-only — a non-streaming Responses call
  // (`stream:false`, what `generateText`'s `doGenerate` always sends) 400s
  // there (same constraint the native transport works around by forcing
  // `stream: true` in chatToResponses regardless of what the client asked
  // for — see its comment). The AI SDK has no equivalent per-call override:
  // the only way to get `stream:true` on the wire is to drive the model
  // through `streamText` (`doStream`). So a Codex call ALWAYS goes through
  // streamText below, even when the client itself asked for a non-streaming
  // completion — that settled result is then collapsed into one JSON response
  // instead of relayed as SSE, matching openai-responses/response.ts's
  // `collectStreamAsChat` for the identical client-non-streaming/
  // upstream-stream-only combination.
  if (clientWantsStream || isCodex) {
    const result = streamText({
      ...shared,
      onError: () => {
        /* error is surfaced through fullStream as an `error` part; swallow the
           unhandled-rejection path here. */
      },
    });
    guardAgainstUnhandledResultRejections(result);

    if (clientWantsStream) {
      return sseResponse(openAiSseFromFullStream(result.fullStream, ctx));
    }

    // Codex + a client that wants JSON: await the same settled-result promises
    // `guardAgainstUnhandledResultRejections` already made safe to await, and
    // build the identical JSON shape `generateText`'s branch below produces.
    try {
      const [text, reasoningText, toolCalls, finishReason, usage, providerMetadata] =
        await Promise.all([
          result.text,
          result.reasoningText,
          result.toolCalls,
          result.finishReason,
          result.usage,
          result.providerMetadata,
        ]);
      return jsonResponse(
        openAiJsonFromResult(
          {
            text,
            reasoningText,
            toolCalls: mapToolCalls(toolCalls),
            finishReason,
            usage,
            providerMetadata,
          },
          ctx,
        ),
      );
    } catch (err) {
      throw toTransportError(err, descriptor.provider);
    }
  }

  try {
    const result = await generateText(shared);
    return jsonResponse(
      openAiJsonFromResult(
        {
          text: result.text,
          reasoningText: result.reasoningText,
          toolCalls: mapToolCalls(result.toolCalls),
          finishReason: result.finishReason,
          usage: result.usage,
          providerMetadata: result.providerMetadata,
        },
        ctx,
      ),
    );
  } catch (err) {
    throw toTransportError(err, descriptor.provider);
  }
}
