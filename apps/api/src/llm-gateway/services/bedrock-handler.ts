import { bedrockConverse, bedrockConverseStream, type BedrockClientConfig } from './bedrock-client';
import {
  openaiToConverse,
  converseToOpenai,
  makeStreamTranslator,
} from './bedrock-translate';
import { resolveBedrockModel } from './bedrock-models';
import type { ExtractedUsage } from './usage-extractor';

const REASONING_BUDGET_BY_EFFORT: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

/** Derive an Anthropic thinking budget (tokens) from the OpenAI-style body. */
function reasoningBudget(body: Record<string, unknown>, modelReasoning: boolean): number {
  if (!modelReasoning) return 0;
  // Explicit Anthropic-style thinking block wins.
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
    return thinking.budget_tokens;
  }
  const effort =
    (typeof body.reasoning_effort === 'string' && body.reasoning_effort) ||
    (typeof (body.reasoning as { effort?: string })?.effort === 'string' &&
      (body.reasoning as { effort?: string }).effort) ||
    '';
  if (effort) return REASONING_BUDGET_BY_EFFORT[effort] ?? REASONING_BUDGET_BY_EFFORT.medium;
  return 0;
}

export interface BedrockHandlerResult {
  response: Response;
}

/**
 * Serve a chat-completions request via AWS Bedrock. `onUsage` is invoked once
 * with token usage (so the caller can run the shared billing/usage pipeline,
 * exactly as the OpenRouter path does). Mirrors the OpenRouter handler's
 * streaming-disconnect handling: keep draining upstream after the client drops
 * so we still capture the final usage.
 */
export async function handleBedrockCompletion(args: {
  body: Record<string, unknown>;
  modelId: string;
  streaming: boolean;
  clientConfig: BedrockClientConfig;
  requestId: string;
  onUsage: (usage: ExtractedUsage, model: string) => void;
}): Promise<Response> {
  const { body, modelId, streaming, clientConfig, requestId, onUsage } = args;

  const entry = resolveBedrockModel(modelId);
  if (!entry) {
    return new Response(JSON.stringify({ error: `Unknown Bedrock model: ${modelId}` }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const budget = reasoningBudget(body, !!entry.reasoning);
  const converseReq = openaiToConverse(body, entry.bedrockId, budget);

  if (!streaming) {
    let out: Awaited<ReturnType<typeof bedrockConverse>>;
    try {
      out = await bedrockConverse(clientConfig, converseReq);
    } catch (err) {
      return bedrockError(err);
    }
    const json = converseToOpenai(out, modelId, requestId);
    const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    onUsage(
      {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      },
      modelId,
    );
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Streaming
  let streamOut: Awaited<ReturnType<typeof bedrockConverseStream>>;
  try {
    streamOut = await bedrockConverseStream(clientConfig, converseReq);
  } catch (err) {
    return bedrockError(err);
  }

  const translator = makeStreamTranslator(modelId, requestId);
  const encoder = new TextEncoder();
  const passthrough = new TransformStream<Uint8Array, Uint8Array>();
  const writer = passthrough.writable.getWriter();

  let captured: ExtractedUsage | null = null;

  (async () => {
    let downstreamAlive = true;
    const write = async (s: string) => {
      if (!downstreamAlive) return;
      try {
        await writer.write(encoder.encode(s));
      } catch {
        downstreamAlive = false;
      }
    };
    try {
      await write(translator.start());
      const events = streamOut.stream as AsyncIterable<Record<string, any>> | undefined;
      if (events) {
        for await (const ev of events) {
          if (ev?.metadata?.usage) {
            const u = ev.metadata.usage;
            captured = {
              promptTokens: u.inputTokens ?? 0,
              completionTokens: u.outputTokens ?? 0,
              cachedTokens: u.cacheReadInputTokens ?? 0,
            };
          }
          for (const s of translator.event(ev)) await write(s);
        }
      }
      await write(translator.done());
    } catch (err) {
      console.warn(`[llm-gateway] bedrock stream error ${requestId}:`, err);
    } finally {
      try {
        await writer.close();
      } catch {
      }
      if (captured && captured.promptTokens + captured.completionTokens > 0) {
        onUsage(captured, modelId);
      }
    }
  })().catch(() => {});

  return new Response(passthrough.readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

function bedrockError(err: unknown): Response {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode ?? 502;
  const message = e?.message || 'Bedrock upstream error';
  console.warn('[llm-gateway] bedrock error:', e?.name, message);
  return new Response(JSON.stringify({ error: message, code: e?.name }), {
    status: status >= 400 && status < 600 ? status : 502,
    headers: { 'content-type': 'application/json' },
  });
}
