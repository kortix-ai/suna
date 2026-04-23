import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../../types';
import {
  proxyToAnthropic,
  extractAnthropicUsage,
  calculateAnthropicCost,
} from '../services/anthropic';
import { getModel } from '../config/models';
import { checkCredits, deductLLMCredits } from '../services/billing';
import {
  applyActorSpend,
  dollarsToCents,
  getSandboxMemberCapStatus,
} from '../services/member-spend';
import {
  resolveActorFromRequest,
  type ActorContext,
} from '../../shared/actor-context';

const anthropic = new Hono<{ Variables: AppContext }>();


/**
 * POST /messages
 *
 * Anthropic Messages API proxy — forwards to Anthropic's /v1/messages endpoint.
 *
 * Handles:
 * - Model resolution (Kortix model IDs → Anthropic native model IDs)
 * - Credit checking and cache-aware billing
 * - Streaming (SSE) and non-streaming responses
 *
 * Preserves cache_control fields injected by @ai-sdk/anthropic's setCacheKey.
 */
anthropic.post('/messages', async (c) => {
  const accountId = c.get('accountId');

  // Parse request body
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }

  // Minimal validation
  if (!body.model || typeof body.model !== 'string') {
    throw new HTTPException(400, {
      message: 'Validation error: model is required',
    });
  }
  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    throw new HTTPException(400, {
      message:
        'Validation error: messages is required and must be a non-empty array',
    });
  }

  const modelId = body.model as string;
  const isStreaming = body.stream === true;

  // Extract session_id from metadata (Anthropic SDK may send it in metadata)
  const metadata = body.metadata as Record<string, unknown> | undefined;
  const sessionId =
    typeof metadata?.session_id === 'string' ? metadata.session_id : undefined;

  // Per-member cap enforcement (same pattern as /llm/chat/completions).
  const actor = resolveActorFromRequest(c, { logPrefix: '[LLM][Anthropic]' });
  if (actor) {
    const status = await getSandboxMemberCapStatus(actor.sandboxId, actor.userId);
    if (status && status.capCents !== null && status.currentCents >= status.capCents) {
      throw new HTTPException(402, {
        message: `Spending cap reached ($${(status.capCents / 100).toFixed(2)} / cycle). Ask the instance owner to raise or remove the cap.`,
      });
    }
  }

  // Check credits
  const creditCheck = await checkCredits(accountId);
  if (!creditCheck.hasCredits) {
    throw new HTTPException(402, {
      message: creditCheck.message || 'Insufficient credits',
    });
  }

  // Get model config for billing
  const modelConfig = getModel(modelId);

  // Proxy to Anthropic
  const response = await proxyToAnthropic(body, isStreaming);

  // If Anthropic returned an error, pass it through
  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      `[LLM][Anthropic] Error ${response.status}: ${errorBody}`,
    );
    return new Response(errorBody, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('Content-Type') || 'application/json',
      },
    });
  }

  if (isStreaming) {
    // Stream: pipe SSE response through, extract usage from billing stream
    const upstreamBody = response.body;
    if (!upstreamBody) {
      throw new HTTPException(502, {
        message: 'No response body from upstream',
      });
    }

    const [clientStream, billingStream] = upstreamBody.tee();

    // Fire-and-forget: extract usage and deduct credits
    extractUsageFromAnthropicStream(
      billingStream,
      modelConfig,
      modelId,
      accountId,
      sessionId,
      actor,
    );

    return new Response(clientStream, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('Content-Type') || 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // Non-streaming: read response, extract usage, bill, return
  const responseBody = await response.json();

  const usage = extractAnthropicUsage(responseBody);
  if (usage) {
    const cost = calculateAnthropicCost(modelConfig, usage);
    deductLLMCredits(
      accountId,
      modelId,
      usage.inputTokens,
      usage.outputTokens,
      cost,
      sessionId,
    )
      .then((res) => {
        if (res.success && actor && cost > 0) {
          applyActorSpend(actor.sandboxId, actor.userId, dollarsToCents(cost)).catch(
            (err) => console.error('[LLM][Anthropic] Actor spend attribution failed:', err),
          );
        }
      })
      .catch((err) =>
        console.error(
          `[LLM][Anthropic] Failed to deduct credits for ${modelId}:`,
          err,
        ),
      );
    console.log(
      `[LLM][Anthropic] ${modelId}: ${usage.inputTokens}in/${usage.outputTokens}out ` +
        `(cache: ${usage.cacheReadInputTokens}read/${usage.cacheCreationInputTokens}write), ` +
        `cost=$${cost.toFixed(6)}`,
    );
  }

  return c.json(responseBody);
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Read through the Anthropic SSE stream to extract usage from the message_stop event,
 * then deduct credits. Runs in background (fire-and-forget).
 *
 * Anthropic SSE format:
 *   event: message_start    → { message: { usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens } } }
 *   event: message_delta    → { usage: { output_tokens } }
 *   event: message_stop
 */
async function extractUsageFromAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  modelConfig: import('../config/models').ModelConfig,
  modelId: string,
  accountId: string,
  sessionId?: string,
  actor?: ActorContext | null,
) {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));

          // message_start contains input usage
          if (data.type === 'message_start' && data.message?.usage) {
            inputTokens = data.message.usage.input_tokens ?? 0;
            cacheCreationInputTokens =
              data.message.usage.cache_creation_input_tokens ?? 0;
            cacheReadInputTokens =
              data.message.usage.cache_read_input_tokens ?? 0;
          }

          // message_delta contains output usage
          if (data.type === 'message_delta' && data.usage) {
            outputTokens = data.usage.output_tokens ?? 0;
          }
        } catch {
          // Not valid JSON — skip
        }
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      const usage = {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
      };
      const cost = calculateAnthropicCost(modelConfig, usage);
      const deductRes = await deductLLMCredits(
        accountId,
        modelId,
        inputTokens,
        outputTokens,
        cost,
        sessionId,
      );
      if (deductRes.success && actor && cost > 0) {
        applyActorSpend(actor.sandboxId, actor.userId, dollarsToCents(cost)).catch(
          (err) => console.error('[LLM][Anthropic] Actor spend attribution failed:', err),
        );
      }
      console.log(
        `[LLM][Anthropic] Stream ${modelId}: ${inputTokens}in/${outputTokens}out ` +
          `(cache: ${cacheReadInputTokens}read/${cacheCreationInputTokens}write), ` +
          `cost=$${cost.toFixed(6)}`,
      );
    } else {
      console.warn(
        `[LLM][Anthropic] Stream ${modelId}: no usage data found — billing skipped`,
      );
    }
  } catch (err) {
    console.error(
      `[LLM][Anthropic] Error extracting usage from stream:`,
      err,
    );
  }
}

export { anthropic };
