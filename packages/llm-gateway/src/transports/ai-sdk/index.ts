import { generateText, streamText } from 'ai';
import { NetworkError, UpstreamHttpError } from '../../errors';
import type { UpstreamDescriptor } from '../../domain';
import {
  clampMaxOutputTokensForBedrock,
  resolveAiModel,
  aiSdkFamilyFor,
  isCodexDescriptor,
} from './model';
import { buildAiSdkArgs } from './request';
import { openAiJsonFromResult, openAiSseFromFullStream } from './sse';

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
function toTransportError(err: unknown, provider: string): Error {
  const e = err as { statusCode?: number; responseBody?: string; message?: string; url?: string };
  if (typeof e?.statusCode === 'number') {
    return new UpstreamHttpError(e.statusCode, e.responseBody ?? e.message ?? '', provider);
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
  return toolCalls?.map((tc) => ({ toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input }));
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
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  const family = aiSdkFamilyFor(descriptor);
  const isCodex = isCodexDescriptor(descriptor);
  // `body` decides chat.completions vs Responses for the 'openai' family (see
  // model.ts's needsResponsesApi) — Codex/genuine-OpenAI-reasoning-with-tools
  // only, everything else keeps using .chat().
  const model = resolveAiModel(descriptor, body);
  const args = buildAiSdkArgs(body, family, {
    // The ChatGPT Codex backend always expects a reasoning effort; the native
    // transport defaults to 'low' when the caller sends none (see
    // openai-responses/request.ts's `chatToResponses`) — mirrored here via
    // buildAiSdkArgs's opt-in default rather than in buildAiSdkArgs itself, so
    // every non-Codex caller's "no default effort" behavior is untouched.
    defaultReasoningEffort: isCodex ? 'low' : undefined,
  });
  const clientWantsStream = body.stream === true;
  const ctx = { model: descriptor.resolvedModel || String(body.model ?? ''), provider: descriptor.provider };

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
      const [text, reasoningText, toolCalls, finishReason, usage, providerMetadata] = await Promise.all([
        result.text,
        result.reasoningText,
        result.toolCalls,
        result.finishReason,
        result.usage,
        result.providerMetadata,
      ]);
      return jsonResponse(
        openAiJsonFromResult(
          { text, reasoningText, toolCalls: mapToolCalls(toolCalls), finishReason, usage, providerMetadata },
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
