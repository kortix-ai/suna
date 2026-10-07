import { config, KORTIX_MARKUP } from '../../config';
import { logger } from '../../lib/logger';
import { OPENROUTER_APP_REFERER, OPENROUTER_APP_TITLE } from '../../openrouter-attribution';
import {
  requireModelPricing,
  resolveOpenRouterId,
  type ModelConfig,
} from '../config/models';
import type { ActorContext } from '../../shared/actor-context';
import {
  refundLlmReservation,
  settleHeldLlmReservation,
  settleLlmReservation,
  type LlmCreditReservation,
} from './llm-reservation';

/**
 * Calculate cost based on token usage and model pricing.
 * When cache metrics are available, uses differential pricing for cached/written tokens.
 *
 * @param markup - Multiplier applied to the raw provider cost.
 *   Defaults to KORTIX_MARKUP (1.2× = 20% markup) when Kortix provides the key.
 *   BYOK callers use 0 because Kortix never charges for provider-owned keys.
 */
export function calculateCost(
  modelConfig: ModelConfig,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number = 0,
  cacheWriteTokens: number = 0,
  markup: number = KORTIX_MARKUP,
  upstreamCostHint?: number,
): number {
  if (typeof upstreamCostHint === 'number' && upstreamCostHint >= 0) {
    return upstreamCostHint * markup;
  }
  const tierCandidates = [
    ...(modelConfig.tiers ?? []),
    ...(modelConfig.contextOver200k ? [modelConfig.contextOver200k] : []),
  ]
    .filter((tier) => promptTokens > tier.contextThreshold)
    .sort((a, b) => b.contextThreshold - a.contextThreshold);
  const pricing = tierCandidates[0] ?? modelConfig;
  // Cache categories are always priced independently. Missing category rates
  // fall back to the plain input rate.
  if (cachedTokens > 0 || cacheWriteTokens > 0) {
    const regularInputTokens = Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
    const regularInputCost = (regularInputTokens / 1_000_000) * pricing.inputPer1M;
    const cacheReadCost =
      (cachedTokens / 1_000_000) * (pricing.cacheReadPer1M ?? pricing.inputPer1M);
    const cacheWriteCost =
      (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePer1M ?? pricing.inputPer1M);
    const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1M;
    return (regularInputCost + cacheReadCost + cacheWriteCost + outputCost) * markup;
  }

  // Fallback: flat input pricing (no cache breakdown)
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1M;
  return (inputCost + outputCost) * markup;
}

/**
 * Forward a chat completion request to OpenRouter as a 1:1 passthrough proxy.
 * Preserves the full request body (tools, tool_choice, response_format, etc).
 *
 * @returns The raw fetch Response from OpenRouter (may be streaming or not).
 */
export async function proxyToOpenRouter(
  body: Record<string, unknown>,
  isStreaming: boolean,
  apiKey = config.OPENROUTER_API_KEY,
  traceHeaders: Record<string, string> = {},
): Promise<Response> {
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OpenRouter API key not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const modelId = body.model as string;
  const openrouterId = resolveOpenRouterId(modelId);

  // Rewrite the model field to the actual OpenRouter model ID
  const forwardBody: Record<string, unknown> = { ...body, model: openrouterId };
  if (isStreaming) {
    forwardBody.stream_options = {
      ...((body.stream_options as Record<string, unknown> | undefined) ?? {}),
      include_usage: true,
    };
  }

  const url = `${config.OPENROUTER_API_URL}/chat/completions`;

  console.log(`[LLM] Proxying to OpenRouter: ${modelId} → ${openrouterId} (stream=${isStreaming})`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': OPENROUTER_APP_REFERER,
      'X-Title': OPENROUTER_APP_TITLE,
      ...traceHeaders,
    },
    body: JSON.stringify(forwardBody),
  });

  return response;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  upstreamCost: number | undefined;
}

/**
 * Extract provider usage into one canonical token shape.
 *
 * Anthropic reports plain input, cache reads, and cache writes separately.
 * `promptTokens` includes all three categories so pricing can subtract the
 * cache categories before it prices the plain-input remainder.
 */
export function extractUsage(
  responseBody: any,
  provider: 'openai' | 'anthropic' = 'openai',
): UsageInfo | null {
  const usage = responseBody?.usage;
  if (!usage) return null;
  if (provider === 'anthropic') {
    const cachedTokens = Number(usage.cache_read_input_tokens ?? 0) || 0;
    const cacheWriteTokens = Number(usage.cache_creation_input_tokens ?? 0) || 0;
    const plainInputTokens = Number(usage.input_tokens ?? 0) || 0;
    return {
      promptTokens: plainInputTokens + cachedTokens + cacheWriteTokens,
      completionTokens: Number(usage.output_tokens ?? 0) || 0,
      cachedTokens,
      cacheWriteTokens,
      upstreamCost: typeof usage.cost === 'number' ? usage.cost : undefined,
    };
  }

  const details = usage.prompt_tokens_details ?? usage.input_tokens_details;
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
    cachedTokens: Number(usage.cached_tokens ?? details?.cached_tokens ?? 0) || 0,
    cacheWriteTokens: Number(usage.cache_write_tokens ?? details?.cache_write_tokens ?? 0) || 0,
    upstreamCost: typeof usage.cost === 'number' ? usage.cost : undefined,
  };
}

export interface UsageAccumulator {
  model?: string;
  usage: UsageInfo;
}

/**
 * The object that carries `usage` in one SSE frame. Anthropic nests it under
 * `message` on `message_start`. The OpenAI Responses API nests it under
 * `response` on the terminal `response.completed` / `response.incomplete` /
 * `response.failed` frames.
 */
function usageSource(chunk: any, provider: 'openai' | 'anthropic'): any {
  if (provider === 'anthropic' && chunk?.type === 'message_start') return chunk.message;
  if (typeof chunk?.type === 'string' && chunk.type.startsWith('response.') && chunk.response?.usage) {
    return chunk.response;
  }
  return chunk;
}

/**
 * Force the upstream to report token usage on an OpenAI-compatible chat
 * completions stream. Without `stream_options.include_usage` OpenAI sends no
 * usage frame, and the stream cannot be billed from the real count.
 * Returns the body unchanged for any other request.
 */
export function forceStreamUsage(
  body: ArrayBuffer | string | undefined,
  headers?: Headers,
): ArrayBuffer | string | undefined {
  if (!body) return body;
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    const json = JSON.parse(text);
    if (json?.stream !== true || !Array.isArray(json.messages)) return body;
    json.stream_options = { ...(json.stream_options ?? {}), include_usage: true };
    const next = JSON.stringify(json);
    headers?.set('Content-Length', new TextEncoder().encode(next).length.toString());
    return next;
  } catch {
    return body;
  }
}

export function accumulateUsageChunk(
  current: UsageAccumulator | null,
  chunk: any,
  provider: 'openai' | 'anthropic' = 'openai',
): UsageAccumulator | null {
  const source = usageSource(chunk, provider);
  const next = extractUsage(source, provider);
  const model = source?.model ?? chunk?.model ?? current?.model;
  if (!next) return current ? { ...current, ...(model ? { model } : {}) } : null;
  if (!current) return { ...(model ? { model } : {}), usage: next };
  return {
    ...(model ? { model } : {}),
    usage: {
      promptTokens: next.promptTokens || current.usage.promptTokens,
      completionTokens: next.completionTokens || current.usage.completionTokens,
      cachedTokens: next.cachedTokens || current.usage.cachedTokens,
      cacheWriteTokens: next.cacheWriteTokens || current.usage.cacheWriteTokens,
      upstreamCost: next.upstreamCost ?? current.usage.upstreamCost,
    },
  };
}

/**
 * Read an SSE stream and accumulate its usage chunks into one
 * UsageAccumulator. Handles both OpenAI-compatible and Anthropic-native
 * SSE formats.
 */
export async function consumeSseUsage(
  stream: ReadableStream<Uint8Array>,
  provider: 'openai' | 'anthropic' = 'openai',
  progress?: { bytes: number },
): Promise<UsageAccumulator | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usageState: UsageAccumulator | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (progress) progress.bytes += value.byteLength;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        usageState = accumulateUsageChunk(usageState, chunk, provider);
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  return usageState;
}

function settleHeld(options: Parameters<typeof settleStreamUsage>[0], modelId: string) {
  return settleHeldLlmReservation({
    reservation: options.reservation,
    accountId: options.accountId,
    modelId,
    actor: options.actor,
    logPrefix: options.logPrefix,
    provider: options.pricingProvider,
    route: options.route,
    streaming: true,
    sessionId: options.sessionId,
  });
}

/**
 * Extract usage from an SSE stream and bill at KORTIX_MARKUP.
 * Handles both OpenAI-compatible and Anthropic-native SSE formats.
 * Runs in background (fire-and-forget). Shared by the LLM router and the
 * proxy handlers; each call site passes its own model resolution and its
 * exact log and refund labels.
 */
export async function settleStreamUsage(options: {
  /** The tee'd billing copy of the upstream SSE stream. */
  stream: ReadableStream<Uint8Array>;
  /** Provider shape of the stream; defaults to OpenAI-compatible. */
  provider?: 'openai' | 'anthropic';
  accountId: string;
  actor: ActorContext | null;
  reservation: LlmCreditReservation | null;
  /** The request's model id; derived from the stream when omitted. */
  modelId?: string;
  /** Resolved pricing; when omitted, the settled model is priced with requireModelPricing. */
  modelConfig?: ModelConfig;
  pricingProvider: string;
  route: string;
  logPrefix: string;
  sessionId?: string;
  /** The labels below are kept verbatim from each call site. */
  noUsageWarning: string;
  /** When set, a zero-token stream refunds instead of settling at cost 0. */
  zeroTokensWarning?: string;
  zeroTokensRefund?: string;
  errorRefund: string;
  scanErrorLog: string;
  refundFailedLog: string;
  successLog: (modelId: string, usage: UsageInfo, cost: number) => string;
}): Promise<void> {
  let settlementStarted = false;
  const progress = { bytes: 0 };
  try {
    const usageState = await consumeSseUsage(options.stream, options.provider, progress);
    const modelId = options.modelId ?? usageState?.model ?? 'unknown';

    if (!usageState) {
      // The client already received the stream. Fail closed: keep the held amount.
      console.warn(options.noUsageWarning);
      settlementStarted = true;
      await settleHeld(options, modelId);
      return;
    }

    const usage = usageState.usage;
    // The proxy refunds a zero-token stream; the router settles it at cost 0.
    if (
      usage.promptTokens > 0 ||
      usage.completionTokens > 0 ||
      options.zeroTokensRefund === undefined
    ) {
      const modelConfig =
        options.reservation?.modelConfig ??
        options.modelConfig ??
        requireModelPricing(modelId, options.pricingProvider);
      const cost = calculateCost(
        modelConfig,
        usage.promptTokens,
        usage.completionTokens,
        usage.cachedTokens,
        usage.cacheWriteTokens,
        KORTIX_MARKUP,
        usage.upstreamCost,
      );
      settlementStarted = true;
      await settleLlmReservation({
        accountId: options.accountId,
        modelId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        actualCost: cost,
        reservation: options.reservation,
        actor: options.actor,
        logPrefix: options.logPrefix,
        provider: options.pricingProvider,
        route: options.route,
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        upstreamCost: usage.upstreamCost,
        streaming: true,
        upstreamStatus: 200,
        sessionId: options.sessionId,
      });
      console.log(options.successLog(modelId, usage, cost));
    } else {
      console.warn(options.zeroTokensWarning);
      await refundLlmReservation(options.reservation, options.zeroTokensRefund);
    }
  } catch (err) {
    console.error(options.scanErrorLog, err);
    if (!settlementStarted && progress.bytes > 0) {
      // The stream broke after the client received bytes: keep the held amount.
      await settleHeld(options, options.modelId ?? 'unknown').catch((settleError) =>
        logger.error(options.refundFailedLog, { error: String(settleError) }),
      );
    } else if (!settlementStarted) {
      await refundLlmReservation(options.reservation, options.errorRefund).catch((refundError) =>
        console.error(options.refundFailedLog, refundError),
      );
    }
  }
}

// Re-export model functions used by router handlers.
export { getModel, getAllModels } from '../config/models';
