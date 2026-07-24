import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayHooks,
  GatewayTrace,
  UsageEvent,
} from '@kortix/llm-gateway';
import { assertBillingActive, BillingGateError } from '../billing/services/billing-gate';
import { deductForLlmUsage, grantCredits } from '../billing/services/credits';
import { getCachedAccountTier } from '../billing/services/entitlements';
import { accountIsFreeTierForModels, llmPriceMarkup } from '../billing/services/tiers';
import { attributeYoloToken } from '../billing/services/yolo-tokens';
import { config } from '../config';
import { logger } from '../lib/logger';
import { emitOtelSpan, isOtelTraceExporterConfigured } from '../lib/otel';
import { isPureHoldRefund, reconcileBillingHold } from './billing-hold-reconciliation';
import { validateAccountToken } from '../repositories/account-tokens';
import { isGatewayKey } from '../shared/crypto';
import { recordGatewayTrace } from '../shared/gateway-logs';
import { recordUsageEvent } from '../shared/usage-events';
import { checkBudget } from './budgets';
import { resolveDefaultModelForPrincipal } from './resolution/default-model';
import { validateGatewayKey } from './gateway-keys';
import { gatewayModelCatalog } from './models/catalog-models';
import { resolveGatewayRoute } from './routing';
import { resolveCandidates } from './resolution/resolve-candidates';

// ─── Canonical gateway control plane ────────────────────────────────────────
//
// The single in-process implementation of every gateway hook. It is consumed
// in two ways over the SAME functions:
//   1. In-API mount — createGateway(createInProcessGatewayHooks()) runs the full
//      pipeline inside the API process (self-host / dev / fallback).
//   2. Standalone service — internal-routes.ts exposes these as /internal/gateway
//      RPC so the out-of-process gateway pod can reach them over HTTP.
// Neither path re-implements auth resolution, usage recording, or trace
// persistence — they live here once.

/**
 * Resolve a caller token to a principal. Precedence:
 *   gateway API key (kgw_…)  →  legacy per-member YOLO token  →  account PAT.
 * Returns null for an unknown/expired/revoked token.
 */
export async function authenticatePrincipal(token: string): Promise<AuthedPrincipal | null> {
  const principal = await resolvePrincipal(token);
  return principal ? withResolvedTier(principal) : null;
}

async function resolvePrincipal(token: string): Promise<AuthedPrincipal | null> {
  if (isGatewayKey(token)) {
    return validateGatewayKey(token);
  }
  const yolo = await attributeYoloToken(token);
  if (yolo) return yolo;
  const account = await validateAccountToken(token);
  if (account.isValid && account.userId && account.accountId) {
    // projectId/sessionId attribute usage to the calling session (the sandbox
    // executor token is minted per-session with session_id = sandbox_id) — the
    // reaper's activity signal + precise per-session billing.
    return {
      userId: account.userId,
      accountId: account.accountId,
      projectId: account.projectId ?? undefined,
      sessionId: account.sessionId ?? undefined,
    };
  }
  return null;
}

/**
 * Attach the resolved billing tier + `freeModelsOnly` flag to a principal once,
 * at authentication, so they travel with it everywhere — including across the
 * RPC boundary to the out-of-process gateway pod — and decide whether managed
 * Kortix models are visible without a second tier lookup. When internal billing
 * is off (self-host) every account sees the full lineup.
 */
async function withResolvedTier(principal: AuthedPrincipal): Promise<AuthedPrincipal> {
  const tiered: AuthedPrincipal = config.KORTIX_BILLING_INTERNAL_ENABLED
    ? await (async () => {
        const tier = await getCachedAccountTier(principal.accountId);
        return { ...principal, tier, freeModelsOnly: accountIsFreeTierForModels(tier) };
      })()
    : { ...principal, freeModelsOnly: false };
  // Resolve the account/project/agent-configured concrete default once, here,
  // so it travels with the principal across the standalone-gateway RPC boundary.
  // Never let a resolution error break authentication for every LLM call.
  let defaultModel: string | undefined;
  try {
    defaultModel = await resolveDefaultModelForPrincipal(tiered);
  } catch {
    defaultModel = undefined;
  }
  return defaultModel ? { ...tiered, defaultModel } : tiered;
}

/**
 * A 'warn' gateway budget is a soft cap: it must never block a request, but it
 * must not be a silent no-op either (it previously wasn't even queried). This
 * is the one place both call sites below surface it — a structured, alertable
 * log line, so a team lead who configured a 'warn' budget gets SOME signal
 * instead of nothing. (A UI notification / email digest is a larger product
 * surface left for a follow-up; see PR description.)
 */
function logGatewayBudgetWarnings(principal: AuthedPrincipal, warnings: string[] | undefined): void {
  if (!warnings?.length) return;
  for (const message of warnings) {
    logger.warn(`[gateway] budget warn threshold reached: ${message}`, {
      accountId: principal.accountId,
      projectId: principal.projectId,
      userId: principal.userId,
    });
  }
}

/** Throw with the budget message when a project/member gateway budget is exhausted. */
export async function assertGatewayBudget(principal: AuthedPrincipal): Promise<void> {
  const { exceeded, message, warnings } = await checkBudget(principal);
  logGatewayBudgetWarnings(principal, warnings);
  if (exceeded) throw new Error(message ?? 'Budget exceeded');
}

/**
 * The combined pre-dispatch gate — authenticate + billing + budget in one call.
 * Backs the /internal/gateway/authorize RPC so the standalone gateway folds three
 * sequential round-trips into one. Returns a principal or a typed 401/402 denial.
 */
export async function authorizeRequest(token: string): Promise<AuthorizeResult> {
  let principal = await authenticatePrincipal(token);
  if (!principal) {
    return { ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' };
  }
  try {
    const billing = await assertLlmBillingActive(principal.accountId);
    if (billing?.holdUsd) principal = { ...principal, billingHold: { amountUsd: billing.holdUsd } };
  } catch (err) {
    return {
      ok: false,
      status: 402,
      // The real reason (subscription_required / insufficient_credits /
      // no_account) — not a hardcoded constant. See BillingGateError's doc
      // comment: without this, every billing denial reported the same code
      // regardless of cause, masking the true failure-mode breakdown in
      // gateway_request_logs and in any programmatic caller that trusts `code`
      // over regexing `message`.
      errorCode: err instanceof BillingGateError ? err.reason : 'subscription_required',
      message: err instanceof Error ? err.message : 'Billing inactive',
      principal,
    };
  }
  const { exceeded, message, warnings } = await checkBudget(principal);
  logGatewayBudgetWarnings(principal, warnings);
  if (exceeded) {
    // A hold was taken above but the budget gate denies dispatch — the caller
    // (handler.ts's admit()) refunds it via refundBillingHold when it sees
    // this denial's `principal`.
    return {
      ok: false,
      status: 402,
      errorCode: 'budget_exceeded',
      message: message ?? 'Budget exceeded',
      principal,
    };
  }
  return { ok: true, principal };
}

/**
 * Apply the LLM wallet gate only to accounts that can spend wallet credits on
 * Kortix-managed models. Free-tier wallets fund sandbox compute only.
 */
export async function assertLlmBillingActive(
  accountId: string,
): Promise<{ holdUsd?: number } | void> {
  if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
    const tier = await getCachedAccountTier(accountId);
    if (accountIsFreeTierForModels(tier)) return;
  }
  return assertBillingActive(accountId);
}

/**
 * Record a usage event (always, for observability, unless it's a pure hold
 * refund with nothing to observe) and settle the wallet.
 *
 * When `event.billingHoldUsd` is set, an atomic admission hold was already
 * taken at the pre-dispatch billing gate (see billing-gate.ts checkBillingActive)
 * — this reconciles it to the real `finalCost` instead of a flat deduct: tops
 * up the remainder if the real cost exceeds the hold, refunds the unused
 * portion otherwise (always the case for a pure hold-refund, where finalCost
 * is 0). Otherwise (no hold — billing disabled, self-host, or an active
 * per-seat subscription that bypasses the wallet floor) falls back to the
 * original flat deduct, skipped entirely when the route isn't billable
 * (billingMode === 'none').
 */
export async function recordGatewayUsage(event: UsageEvent): Promise<void> {
  const pureHoldRefund = isPureHoldRefund(event);

  const usageEventId = pureHoldRefund
    ? null
    : await recordUsageEvent({
        accountId: event.accountId,
        actorUserId: event.actorUserId,
        projectId: event.projectId ?? null,
        sessionId: event.sessionId ?? null,
        provider: event.provider,
        model: event.model,
        route: '/v1/llm/chat/completions',
        inputTokens: event.promptTokens,
        outputTokens: event.completionTokens,
        cachedTokens: event.cachedTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        costUsd: event.finalCost,
        streaming: event.streaming,
        metadata: {
          upstreamCostUsd: event.upstreamCost,
          markup: llmPriceMarkup(),
          requestId: event.requestId,
          billingMode: event.billingMode,
        },
      });

  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return;

  if (event.billingHoldUsd != null) {
    const { toDeduct, toRefund } = reconcileBillingHold(event.finalCost, event.billingHoldUsd);
    if (toDeduct > 0) {
      // The real cost exceeded the (small, fixed) admission hold — collect
      // the difference. Still a flat atomic deduct (deductForLlmUsage →
      // atomic_use_credits), so it can never take the balance negative; if
      // the account has since run dry, this is the same best-effort,
      // logged-not-thrown gap the flat-deduct path always had — now bounded
      // to (finalCost - holdUsd) instead of the full finalCost.
      await deductForLlmUsage({
        accountId: event.accountId,
        costUsd: toDeduct,
        model: event.model,
        provider: event.provider,
        actorUserId: event.actorUserId,
        usageEventId,
        upstreamCostUsd: event.upstreamCost,
        markup: llmPriceMarkup(),
      });
    } else if (toRefund > 0) {
      await grantCredits(
        event.accountId,
        toRefund,
        'llm_reservation_refund',
        `LLM gateway admission-hold refund${event.model && event.model !== 'unknown' ? ` · ${event.model}` : ''}`,
        false,
      );
    }
    return;
  }

  if (event.billingMode === 'none') return;
  await deductForLlmUsage({
    accountId: event.accountId,
    costUsd: event.finalCost,
    model: event.model,
    provider: event.provider,
    actorUserId: event.actorUserId,
    usageEventId,
    upstreamCostUsd: event.upstreamCost,
    markup: llmPriceMarkup(),
  });
}

/**
 * Build + fire a standard OTel `gen_ai.*` span for one gateway call.
 *
 * Best-effort telemetry only: gated on isOtelTraceExporterConfigured() so we
 * skip building the attributes object entirely when no OTLP endpoint is
 * configured (the common self-host case), fire-and-forget (never awaited by
 * the caller), and guarded so a span-emission failure can never throw into —
 * or block — trace persistence or billing.
 */
export function emitGatewayGenAiSpan(trace: GatewayTrace): void {
  if (!isOtelTraceExporterConfigured()) return;
  try {
    const endTimeMs = Date.now();
    const startTimeMs = endTimeMs - Math.max(0, trace.latencyMs || 0);
    const resolvedModel = trace.resolvedModel || trace.requestedModel;
    void emitOtelSpan({
      name: `chat ${resolvedModel}`,
      kind: 'INTERNAL',
      startTimeMs,
      endTimeMs,
      attributes: {
        'gen_ai.system': trace.provider,
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': trace.requestedModel,
        'gen_ai.response.model': resolvedModel,
        'gen_ai.usage.input_tokens': trace.usage.promptTokens,
        'gen_ai.usage.output_tokens': trace.usage.completionTokens,
        'kortix.cost_usd': trace.finalCost,
        'kortix.upstream_cost_usd': trace.upstreamCost,
        'kortix.provider': trace.provider,
        'kortix.cached_tokens': trace.usage.cachedTokens,
        'kortix.streaming': trace.streaming,
        'kortix.billing_mode': trace.billingMode,
        'kortix.request_id': trace.requestId,
        'kortix.attempts': trace.attempts,
        'kortix.gateway_status': trace.status,
        'kortix.ok': trace.ok,
        ...(trace.errorCode ? { 'kortix.error_code': trace.errorCode } : {}),
      },
    }).catch((error) => {
      console.warn(
        '[otel] gen_ai span emit failed:',
        error instanceof Error ? error.message : error,
      );
    });
  } catch (error) {
    console.warn(
      '[otel] gen_ai span build failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

/** Persist a request trace to gateway_request_logs (skips unauthenticated traces). */
export async function persistGatewayTrace(trace: GatewayTrace): Promise<void> {
  // Pre-auth failures (401) carry no accountId — nothing useful to attribute.
  if (!trace.accountId) return;
  await recordGatewayTrace({
    requestId: trace.requestId,
    accountId: trace.accountId,
    projectId: trace.projectId,
    sessionId: trace.sessionId,
    actorUserId: trace.actorUserId,
    keyId: trace.keyId,
    requestedModel: trace.requestedModel,
    resolvedModel: trace.resolvedModel || trace.requestedModel,
    provider: trace.provider,
    status: trace.status,
    ok: trace.ok,
    errorCode: trace.errorCode,
    errorMessage: trace.errorMessage,
    latencyMs: trace.latencyMs,
    attempts: trace.attempts,
    candidatesTried: trace.candidatesTried,
    promptTokens: trace.usage.promptTokens,
    completionTokens: trace.usage.completionTokens,
    cachedTokens: trace.usage.cachedTokens,
    upstreamCost: trace.upstreamCost,
    finalCost: trace.finalCost,
    streaming: trace.streaming,
    billingMode: trace.billingMode,
    request: trace.request,
    response: trace.response,
    // gateway_request_logs has no cache_write_tokens column (unlike
    // usage_events, which does) — stash it in metadata rather than take on a
    // schema migration for a purely observational field; the dollar amount
    // (finalCost/upstreamCost) already reflects the cache-write premium.
    metadata: { ...trace.metadata, cacheWriteTokens: trace.usage.cacheWriteTokens },
  });
  // Non-blocking: never let telemetry delay the caller or affect the trace write.
  emitGatewayGenAiSpan(trace);
}

/** The full set of hooks the pipeline needs, bound to the in-process control plane. */
export function createInProcessGatewayHooks(): GatewayHooks {
  return {
    authenticate: authenticatePrincipal,
    resolveRoute: resolveGatewayRoute,
    resolveUpstream: resolveCandidates,
    assertBillingActive: assertLlmBillingActive,
    assertBudget: assertGatewayBudget,
    recordUsage: recordGatewayUsage,
    recordTrace: persistGatewayTrace,
    listModels: async (principal) =>
      gatewayModelCatalog(principal.projectId, {
        freeManagedOnly: !!principal.freeModelsOnly,
      }),
  };
}
