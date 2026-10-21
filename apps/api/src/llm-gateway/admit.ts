import type { ModelRouteInput } from '@kortix/llm-gateway';
import { GatewayResolutionError } from '@kortix/llm-gateway';
import { logger } from '../lib/logger';
import { assertLlmBillingActive, authorizeRequest } from './hooks';
import { resolveCandidates } from './resolution/resolve-candidates';
import { resolveGatewayRoute } from './routing';

export function resolutionErrorBody(err: GatewayResolutionError) {
  return { code: err.code, message: err.message, suggestion: err.suggestion, retryAfterSeconds: err.retryAfterSeconds, restSeconds: err.restSeconds };
}

/**
 * The wallet admission for a Kortix-billed request the gateway already
 * resolved (`simple-handler.ts` gates admitCharge on billingMode), so the
 * wallet floor applies to every account here. An active verdict DEBITS the
 * admission hold; the caller must return `holdUsd` to the gateway.
 */
export async function billingVerdict(accountId: string) {
  try {
    const result = await assertLlmBillingActive(accountId, { creditsRequest: true });
    return { active: true as const, holdUsd: result?.holdUsd };
  } catch (err) {
    return {
      active: false as const,
      reason: typeof (err as { reason?: unknown })?.reason === 'string'
        ? (err as { reason: string }).reason
        : 'subscription_required',
      message: err instanceof Error ? err.message : 'subscription required',
    };
  }
}

/**
 * /authorize + /resolve-route + /resolve-upstream for the routed model +
 * /billing when that model is Kortix-billed, in one call. Each answer has the
 * shape of its own route. A step that fails unexpectedly is left out, and the
 * gateway calls its own route for it, so error handling stays the same. The
 * billing step runs last, so no step after the debit can fail.
 */
export async function admitGatewayRequest(token: unknown, input: unknown) {
  if (typeof token !== 'string' || !token) {
    return { admission: { ok: false as const, status: 401, errorCode: 'invalid_token', message: 'Invalid token' } };
  }
  const admission = await authorizeRequest(token, { deferBilling: true });
  if (!admission.ok) return { admission };
  const { principal } = admission;
  const routeInput = input as ModelRouteInput;
  let route;
  try {
    route = await resolveGatewayRoute(principal, routeInput);
  } catch (err) {
    logger.warn('[gateway-internal] admit: route left to the gateway', { error: err instanceof Error ? err.message : String(err) });
    return { admission };
  }
  const model = route?.primaryModel || routeInput?.requestedModel || '';
  try {
    const candidates = await resolveCandidates(principal, model);
    const billing = candidates[0] && candidates[0].billingMode !== 'none'
      ? await billingVerdict(principal.accountId)
      : undefined;
    return { admission, route, candidates, ...(billing ? { billing } : {}) };
  } catch (err) {
    if (err instanceof GatewayResolutionError) {
      return { admission, route, candidates: [], resolutionError: resolutionErrorBody(err) };
    }
    logger.warn('[gateway-internal] admit: resolution left to the gateway', { error: err instanceof Error ? err.message : String(err) });
    return { admission, route };
  }
}
