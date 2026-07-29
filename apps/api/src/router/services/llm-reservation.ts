import { HTTPException } from 'hono/http-exception';
import { grantCredits } from '../../billing/services/credits';
import { recordUsageEvent } from '../../shared/usage-events';
import type { ActorContext } from '../../shared/actor-context';
import { requireModelPricing, type ModelConfig } from '../config/models';
import { calculateCost } from './llm';
import { deductLLMCredits } from './billing';
import { dollarsToCents, refundActorSpend, reserveActorSpend } from './member-spend';
import {
  reconcileBillingHold,
  roundBillingAmount,
} from '../../llm-gateway/billing-hold-reconciliation';

export interface LlmCreditReservation {
  accountId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  actor?: ActorContext | null;
  actorReservedCents?: number;
  modelConfig: ModelConfig;
  pricingProvider: string;
}

function extractText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';

  const object = value as Record<string, unknown>;
  if (typeof object.text === 'string') return object.text;
  if (typeof object.output_text === 'string') return object.output_text;
  if (typeof object.content === 'string') return object.content;
  if (object.content) return extractText(object.content);
  if (object.output) return extractText(object.output);
  if (object.input) return extractText(object.input);
  return '';
}

async function reserveActorCost(
  actor: ActorContext | null,
  cost: number,
  refundCredits: () => Promise<unknown>,
): Promise<number> {
  const cents = dollarsToCents(cost);
  if (!actor || cents <= 0) return 0;

  const reserved = await reserveActorSpend(actor.sandboxId, actor.userId, cents);
  if (reserved.success) return reserved.reservedCents;

  await refundCredits().catch((error) => {
    console.error('[LLM] Credit refund after member cap failure failed:', error);
  });
  const cap =
    reserved.capCents === null ? 'configured' : `$${(reserved.capCents / 100).toFixed(2)} / cycle`;
  throw new HTTPException(402, {
    message: `Spending cap reached (${cap}). Ask the instance owner to raise or remove the cap.`,
  });
}

export async function reserveEstimatedLlmCredits(
  accountId: string,
  body: ArrayBuffer | string | undefined,
  markup: number,
  actor: ActorContext | null,
  pricingProvider: string = 'openrouter',
): Promise<LlmCreditReservation | null> {
  if (!body) return null;
  let parsed: Record<string, unknown>;
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HTTPException(400, {
      message:
        'LLM proxy requests must include a JSON body so cost can be authorized before upstream execution',
    });
  }

  const modelId = typeof parsed.model === 'string' ? parsed.model : 'unknown';
  const maxOutputTokensRaw =
    parsed.max_tokens ?? parsed.max_completion_tokens ?? parsed.max_output_tokens;
  const maxOutputTokens =
    typeof maxOutputTokensRaw === 'number' && Number.isFinite(maxOutputTokensRaw)
      ? Math.max(0, Math.min(maxOutputTokensRaw, 200_000))
      : 4096;
  const inputText = extractText(parsed.messages ?? parsed.input ?? parsed.prompt ?? '');
  const estimatedInputTokens = Math.ceil(inputText.length / 2);
  let modelConfig: ModelConfig;
  try {
    modelConfig = requireModelPricing(modelId, pricingProvider);
  } catch {
    throw new HTTPException(422, {
      message: `No billing price for ${pricingProvider}/${modelId}. The request was not sent upstream.`,
    });
  }
  const estimatedCost = calculateCost(
    modelConfig,
    estimatedInputTokens,
    maxOutputTokens,
    0,
    0,
    markup,
  );
  const minimum = Math.max(0.01, estimatedCost);

  let creditReservation: Awaited<ReturnType<typeof deductLLMCredits>>;
  try {
    creditReservation = await deductLLMCredits(
      accountId,
      modelId,
      estimatedInputTokens,
      maxOutputTokens,
      minimum,
    );
  } catch (error) {
    throw new HTTPException(402, {
      message: error instanceof Error ? error.message : 'Insufficient credits',
    });
  }
  if (!creditReservation.success) {
    throw new HTTPException(402, {
      message: creditReservation.error || 'Insufficient credits',
    });
  }

  const actorReservedCents = await reserveActorCost(actor, creditReservation.cost, () =>
    grantCredits(
      accountId,
      creditReservation.cost,
      'llm_reservation_refund',
      `LLM reservation refund after member cap: ${modelId}`,
      false,
    ),
  );

  return {
    accountId,
    modelId,
    promptTokens: estimatedInputTokens,
    completionTokens: maxOutputTokens,
    cost: creditReservation.cost,
    actor,
    actorReservedCents,
    modelConfig,
    pricingProvider,
  };
}

export async function settleLlmReservation(input: {
  accountId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  actualCost: number;
  reservation: LlmCreditReservation | null;
  actor: ActorContext | null;
  logPrefix: string;
  provider: string;
  route: string;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  upstreamCost?: number;
  streaming?: boolean;
  upstreamStatus?: number;
  sessionId?: string;
}): Promise<void> {
  const actualCost = roundBillingAmount(input.actualCost);
  const reservedCost = roundBillingAmount(input.reservation?.cost ?? 0);
  const reservedActorCents = input.reservation?.actorReservedCents ?? 0;
  const actor = input.reservation?.actor ?? input.actor;

  if (reservedCost <= 0) {
    try {
      const result = await deductLLMCredits(
        input.accountId,
        input.modelId,
        input.promptTokens,
        input.completionTokens,
        actualCost,
      );
      if (!result.success) {
        console.error(
          `[LLM] ${input.logPrefix} deduction failed: ${result.error || 'unknown error'}`,
        );
      }
    } catch (error) {
      console.error(`[LLM] ${input.logPrefix} deduction failed:`, error);
    }
  } else {
    const { toDeduct, toRefund } = reconcileBillingHold(actualCost, reservedCost);
    if (toDeduct > 0) {
      try {
        const result = await deductLLMCredits(
          input.accountId,
          input.modelId,
          input.promptTokens,
          input.completionTokens,
          toDeduct,
        );
        if (!result.success) {
          console.error(
            `[LLM] ${input.logPrefix} delta deduction failed: ${result.error || 'unknown error'}`,
          );
        }
      } catch (error) {
        console.error(`[LLM] ${input.logPrefix} delta deduction failed:`, error);
      }
    } else if (toRefund > 0) {
      await grantCredits(
        input.accountId,
        toRefund,
        'llm_reservation_refund',
        `LLM reservation refund: ${input.modelId}`,
        false,
      ).catch((error) => {
        console.error(`[LLM] ${input.logPrefix} refund failed:`, error);
      });
    }
  }

  if (actor) {
    const actualCents = dollarsToCents(actualCost);
    const deltaCents = actualCents - reservedActorCents;
    if (deltaCents > 0) {
      try {
        const reserved = await reserveActorSpend(actor.sandboxId, actor.userId, deltaCents);
        if (!reserved.success) {
          console.error(`[LLM] ${input.logPrefix} actor spend delta exceeded cap`);
        }
      } catch (error) {
        console.error(`[LLM] ${input.logPrefix} actor spend delta failed:`, error);
      }
    } else if (deltaCents < 0) {
      await refundActorSpend(actor.sandboxId, actor.userId, Math.abs(deltaCents)).catch((error) =>
        console.error('[LLM] Actor spend refund failed:', error),
      );
    }
  }

  await recordUsageEvent({
    accountId: input.accountId,
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.modelId,
    route: input.route,
    inputTokens: input.promptTokens,
    outputTokens: input.completionTokens,
    cachedTokens: input.cachedTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    costUsd: actualCost,
    streaming: input.streaming,
    upstreamStatus: input.upstreamStatus,
    metadata: {
      upstreamCostUsd: input.upstreamCost ?? null,
      billingSource: input.logPrefix,
    },
  }).catch((error) => {
    console.error(`[LLM] ${input.logPrefix} usage event write failed:`, error);
  });
}

export async function refundLlmReservation(
  reservation: LlmCreditReservation | null,
  description: string,
): Promise<void> {
  if (!reservation) return;
  if (reservation.cost > 0) {
    await grantCredits(
      reservation.accountId,
      reservation.cost,
      'llm_reservation_refund',
      description,
      false,
    );
  }
  if (reservation.actor && (reservation.actorReservedCents ?? 0) > 0) {
    await refundActorSpend(
      reservation.actor.sandboxId,
      reservation.actor.userId,
      reservation.actorReservedCents ?? 0,
    );
  }
}
