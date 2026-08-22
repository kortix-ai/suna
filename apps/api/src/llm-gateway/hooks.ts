import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayTrace,
  UsageEvent,
} from '@kortix/llm-gateway';
import { BillingGateError, assertBillingActive } from '../billing/services/billing-gate';
import { deductForLlmUsage, grantCredits } from '../billing/services/credits';
import { accountMayUseManagedModels, getCachedAccountTier } from '../billing/services/entitlements';
import { llmPriceMarkup } from '../billing/services/tiers';
import { attributeYoloToken } from '../billing/services/yolo-tokens';
import { config } from '../config';
import { logger } from '../lib/logger';
import { emitOtelSpan, isOtelTraceExporterConfigured } from '../lib/otel';
import {
  createExtendThrottle,
  extendSandboxDeadline,
  llmActivityGrantMs,
} from '../projects/sandbox-deadline';
import { validateAccountToken } from '../repositories/account-tokens';
import { isGatewayKey } from '../shared/crypto';
import { recordGatewayTrace } from '../shared/gateway-logs';
import { recordUsageEvent } from '../shared/usage-events';
import { isPureHoldRefund, reconcileBillingHold } from './billing-hold-reconciliation';
import { checkBudget } from './budgets';
import { validateGatewayKey } from './gateway-keys';
import { resolveDefaultModelForPrincipal } from './resolution/default-model';
import { resolveCandidates } from './resolution/resolve-candidates';
import { resolveGatewayRoute } from './routing';

// ─── Canonical gateway control plane ────────────────────────────────────────
//
// The API owns gateway control-plane operations. internal-routes.ts exposes
// these functions to the standalone gateway over authenticated HTTP.

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
    // connector token is minted per-session with session_id = sandbox_id) — the
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
        // Both reads share the entitlements tier-snapshot cache: one DB read,
        // one wall-clock instant, no tier-vs-managed skew. `freeModelsOnly`
        // is the managed-models entitlement (trial overlay + operator
        // override included), not a literal tier=='free' check.
        const [tier, managedModels] = await Promise.all([
          getCachedAccountTier(principal.accountId),
          accountMayUseManagedModels(principal.accountId),
        ]);
        return { ...principal, tier, freeModelsOnly: !managedModels };
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
function logGatewayBudgetWarnings(
  principal: AuthedPrincipal,
  warnings: string[] | undefined,
): void {
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
  // Accounts without the managed-models entitlement (BYOK-only, whether by
  // tier, trial, or operator override) never spend wallet credits on managed
  // inference — their wallets fund sandbox compute only, so skip the LLM gate.
  if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
    if (!(await accountMayUseManagedModels(accountId))) return;
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
/**
 * One deadline write per minute per session for LLM activity. A single turn can
 * make dozens of gateway calls; the extend is monotone, so the ones inside a
 * window would land on the value the first already produced.
 */
const llmActivityThrottle = createExtendThrottle(60_000);

/**
 * THE MID-TURN EXTENSION, and the reason a long turn no longer gets killed.
 *
 * A turn is granted 4 hours when it STARTS, and nothing else used to re-extend
 * it — so the measured tail (MAX ~8.4h, roughly 7-18 turns per 30 days over 4h)
 * was work the reaper would stop mid-flight. `usage_events` closes that: it is
 * written by the gateway after a real upstream completion, never by the sandbox,
 * so it satisfies the invariant — the box cannot mint one without spending real
 * money through our own control plane, and the row IS the billing record.
 *
 * `event.sessionId` is safe as the target for exactly the reason `originRef` is:
 * the gateway principal's session id comes from the connector token, minted
 * server-side with sessionId = sandboxId = the project session id, so a caller
 * cannot name someone else's session. Fire-and-forget — a deadline write must
 * never fail a billing settlement.
 */
function extendDeadlineForLlmActivity(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  if (!llmActivityThrottle.take(sessionId)) return;
  void extendSandboxDeadline({ sessionId }, llmActivityGrantMs()).catch((err) =>
    logger.warn('[deadline] llm-activity extend failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}

export async function recordGatewayUsage(event: UsageEvent): Promise<void> {
  const pureHoldRefund = isPureHoldRefund(event);
  // A pure hold refund observed nothing — no upstream call happened.
  if (!pureHoldRefund) extendDeadlineForLlmActivity(event.sessionId);

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
    const attemptFailures = trace.attemptFailures ?? [];
    const failureCodes = attemptFailures.map((failure) => String(failure.code));
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
        'kortix.cache_write_tokens': trace.usage.cacheWriteTokens,
        'kortix.streaming': trace.streaming,
        'kortix.billing_mode': trace.billingMode,
        'kortix.request_id': trace.requestId,
        'kortix.attempts': trace.attempts,
        'kortix.gateway_status': trace.status,
        'kortix.ok': trace.ok,
        'kortix.failure_count': attemptFailures.length,
        'kortix.failure_codes': failureCodes.join(','),
        'kortix.context_rejected': failureCodes.includes('context_length_exceeded'),
        // `kortix.probe_timeout` removed: the gateway's first-byte deadline
        // commits the stream instead of failing it, so `stream_probe_timeout`
        // can no longer reach a failure chain and the attribute was pinned to
        // false on every span.
        'kortix.fallback_recovered': trace.ok && attemptFailures.length > 0,
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
    cacheWriteTokens: trace.usage.cacheWriteTokens,
    upstreamCost: trace.upstreamCost,
    finalCost: trace.finalCost,
    streaming: trace.streaming,
    billingMode: trace.billingMode,
    request: trace.request,
    response: trace.response,
    metadata: {
      ...trace.metadata,
      ...(trace.attemptFailures?.length ? { attemptFailures: trace.attemptFailures } : {}),
    },
  });
  // Non-blocking: never let telemetry delay the caller or affect the trace write.
  emitGatewayGenAiSpan(trace);
}
