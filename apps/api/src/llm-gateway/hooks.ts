import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayHooks,
  GatewayTrace,
  UsageEvent,
} from '@kortix/llm-gateway';
import { assertBillingActive } from '../billing/services/billing-gate';
import { deductForLlmUsage } from '../billing/services/credits';
import { getCachedAccountTier } from '../billing/services/entitlements';
import { llmPriceMarkup, tierGrantsAllModels } from '../billing/services/tiers';
import { attributeYoloToken } from '../billing/services/yolo-tokens';
import { config } from '../config';
import { validateAccountToken } from '../repositories/account-tokens';
import { isGatewayKey } from '../shared/crypto';
import { recordGatewayTrace } from '../shared/gateway-logs';
import { recordUsageEvent } from '../shared/usage-events';
import { checkBudget } from './budgets';
import { validateGatewayKey } from './gateway-keys';
import { gatewayModelCatalog } from './models/catalog-models';
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
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    return { ...principal, freeModelsOnly: false };
  }
  const tier = await getCachedAccountTier(principal.accountId);
  return { ...principal, tier, freeModelsOnly: !tierGrantsAllModels(tier) };
}

/** Throw with the budget message when a project/member gateway budget is exhausted. */
export async function assertGatewayBudget(principal: AuthedPrincipal): Promise<void> {
  const { exceeded, message } = await checkBudget(principal);
  if (exceeded) throw new Error(message ?? 'Budget exceeded');
}

/**
 * The combined pre-dispatch gate — authenticate + billing + budget in one call.
 * Backs the /internal/gateway/authorize RPC so the standalone gateway folds three
 * sequential round-trips into one. Returns a principal or a typed 401/402 denial.
 */
export async function authorizeRequest(token: string): Promise<AuthorizeResult> {
  const principal = await authenticatePrincipal(token);
  if (!principal) {
    return { ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' };
  }
  try {
    await assertBillingActive(principal.accountId);
  } catch (err) {
    return {
      ok: false,
      status: 402,
      errorCode: 'subscription_required',
      message: err instanceof Error ? err.message : 'Billing inactive',
      principal,
    };
  }
  const { exceeded, message } = await checkBudget(principal);
  if (exceeded) {
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
 * Record a usage event (always, for observability) and debit the wallet when
 * internal billing is on and the route is billable (billingMode !== 'none').
 */
export async function recordGatewayUsage(event: UsageEvent): Promise<void> {
  const usageEventId = await recordUsageEvent({
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
    costUsd: event.finalCost,
    streaming: event.streaming,
    metadata: {
      upstreamCostUsd: event.upstreamCost,
      markup: llmPriceMarkup(),
      requestId: event.requestId,
      billingMode: event.billingMode,
    },
  });

  if (!config.KORTIX_BILLING_INTERNAL_ENABLED || event.billingMode === 'none') return;
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
    metadata: trace.metadata,
  });
}

/** The full set of hooks the pipeline needs, bound to the in-process control plane. */
export function createInProcessGatewayHooks(): GatewayHooks {
  return {
    authenticate: authenticatePrincipal,
    resolveUpstream: resolveCandidates,
    assertBillingActive,
    assertBudget: assertGatewayBudget,
    recordUsage: recordGatewayUsage,
    recordTrace: persistGatewayTrace,
    listModels: async (principal) =>
      gatewayModelCatalog(principal.projectId, {
        freeManagedOnly: !!principal.freeModelsOnly,
      }),
  };
}
