import { KORTIX_MARKUP } from '../../config';
import { accumulateUsageChunk, calculateCost, type UsageAccumulator } from './llm';
import {
  refundLlmReservation,
  settleLlmReservation,
  type LlmCreditReservation,
} from './llm-reservation';
import type { ModelConfig } from '../config/models';
import type { ActorContext } from '../../shared/actor-context';

/**
 * Read an SSE billing stream to completion and accumulate its usage chunks.
 * Handles both OpenAI-compatible and Anthropic-native SSE formats via `provider`.
 * Returns null when no chunk carried a usage object.
 *
 * Buffers by complete line, so a `data:` fragment split across two reads is never
 * parsed on its own.
 */
export async function consumeSseUsage(
  stream: ReadableStream<Uint8Array>,
  provider: 'openai' | 'anthropic' = 'openai',
): Promise<UsageAccumulator | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usageState: UsageAccumulator | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

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

/**
 * Settle one streamed LLM reservation from the accumulated usage. Costs at
 * KORTIX_MARKUP, records the usage event, and refunds the reservation when the
 * stream carried no billable usage or the scan failed. Runs in background.
 *
 * `label`, `logPrefix`, `refundLabel` and `subject` keep each route's provider,
 * route and log text; `requirePositiveTokens` keeps a zero-token usage from
 * billing on routes that guard it.
 */
export async function settleStreamUsage(input: {
  usage: UsageAccumulator | null;
  accountId: string;
  modelId: string;
  modelConfig?: ModelConfig;
  resolveModelConfig?: (modelId: string) => ModelConfig;
  reservation: LlmCreditReservation | null;
  actor: ActorContext | null;
  logPrefix: string;
  provider: string;
  route: string;
  label: string;
  refundLabel: string;
  subject: string;
  sessionId?: string;
  requirePositiveTokens: boolean;
  cacheInfo: boolean;
  markupSuffix: string;
}): Promise<void> {
  let settlementStarted = false;
  try {
    const usage = input.usage?.usage;
    if (!usage) {
      console.warn(`${input.label}: no usage data — billing skipped`);
      await refundLlmReservation(
        input.reservation,
        `${input.refundLabel} refund after missing stream usage: ${input.subject}`,
      );
      return;
    }
    if (input.requirePositiveTokens && usage.promptTokens <= 0 && usage.completionTokens <= 0) {
      console.warn(`${input.label}: zero tokens — billing skipped`);
      await refundLlmReservation(
        input.reservation,
        `${input.refundLabel} refund after zero stream usage: ${input.subject}`,
      );
      return;
    }

    const modelConfig = input.resolveModelConfig
      ? input.resolveModelConfig(input.modelId)
      : input.modelConfig;
    if (!modelConfig) throw new Error(`No billing config for ${input.modelId}`);

    settlementStarted = true;
    const cost = calculateCost(
      modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
      KORTIX_MARKUP,
      usage.upstreamCost,
    );
    await settleLlmReservation({
      accountId: input.accountId,
      modelId: input.modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      actualCost: cost,
      reservation: input.reservation,
      actor: input.actor,
      logPrefix: input.logPrefix,
      provider: input.provider,
      route: input.route,
      cachedTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      upstreamCost: usage.upstreamCost,
      streaming: true,
      upstreamStatus: 200,
      sessionId: input.sessionId,
    });
    const cacheInfo =
      input.cacheInfo && (usage.cachedTokens || usage.cacheWriteTokens)
        ? ` (cache: ${usage.cachedTokens}read/${usage.cacheWriteTokens}write)`
        : '';
    console.log(
      `${input.label} ${input.modelId}: ${usage.promptTokens}/${usage.completionTokens} tokens${cacheInfo}, cost=$${cost.toFixed(6)}${input.markupSuffix}`,
    );
  } catch (err) {
    console.error(`${input.label}: error extracting usage for billing:`, err);
    if (!settlementStarted) {
      await refundLlmReservation(
        input.reservation,
        `${input.refundLabel} refund after stream usage error: ${input.subject}`,
      ).catch((refundError) =>
        console.error(`${input.label}: reservation refund failed:`, refundError),
      );
    }
  }
}
