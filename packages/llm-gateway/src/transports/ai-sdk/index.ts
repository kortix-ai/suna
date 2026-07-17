import { generateText, streamText } from 'ai';
import { NetworkError, UpstreamHttpError } from '../../errors';
import type { UpstreamDescriptor } from '../../domain';
import { resolveAiModel, aiSdkFamilyFor } from './model';
import { buildAiSdkArgs } from './request';
import { openAiJsonFromResult, openAiSseFromFullStream } from './sse';

export { aiSdkFamilyFor, isAiSdkServable, resolveAiModel } from './model';

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
  const model = resolveAiModel(descriptor);
  const args = buildAiSdkArgs(body, family);
  const streaming = body.stream === true;
  const ctx = { model: descriptor.resolvedModel || String(body.model ?? ''), provider: descriptor.provider };

  const shared = {
    model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    toolChoice: args.toolChoice,
    temperature: args.temperature,
    topP: args.topP,
    maxOutputTokens: args.maxOutputTokens,
    stopSequences: args.stopSequences,
    providerOptions: args.providerOptions,
    // The gateway owns retry/failover/circuit-breaking; keep the SDK from adding a
    // second, opaque retry layer on top.
    maxRetries: 0,
    abortSignal: opts.signal,
  } as const;

  if (streaming) {
    const result = streamText({
      ...shared,
      onError: () => {
        /* error is surfaced through fullStream as an `error` part; swallow the
           unhandled-rejection path here. */
      },
    });
    return sseResponse(openAiSseFromFullStream(result.fullStream, ctx));
  }

  try {
    const result = await generateText(shared);
    return jsonResponse(
      openAiJsonFromResult(
        {
          text: result.text,
          reasoningText: result.reasoningText,
          toolCalls: result.toolCalls?.map((tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: (tc as { input?: unknown }).input,
          })),
          finishReason: result.finishReason,
          usage: result.usage,
        },
        ctx,
      ),
    );
  } catch (err) {
    throw toTransportError(err, descriptor.provider);
  }
}
