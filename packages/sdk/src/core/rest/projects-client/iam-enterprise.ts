import { retiredEndpointError } from '../../http/api/errors';

// ─── Enterprise preview (retired) ─────────────────────────────────────────
// The self-serve Enterprise preview is gone (2026-10-15). Enterprise features
// come from the Enterprise plan — a contract or an Enterprise trial an operator
// grants — and the account reads them from `getAccountState()`: `plan.family`,
// `trial` and `tier.entitlements`.

const PLAN_INSTEAD = "Read plan.family, trial and tier.entitlements from getAccountState().";

/**
 * @deprecated The Enterprise preview is retired: the API answers 410 on its
 * route. Always rejects with `ENDPOINT_RETIRED` and sends no request. Read the
 * Enterprise plan from `getAccountState()`. Removed in the next major.
 */
export async function getEnterpriseDemo(_accountId: string): Promise<boolean> {
  throw retiredEndpointError('getEnterpriseDemo', PLAN_INSTEAD);
}

/**
 * @deprecated The Enterprise preview is retired: the API answers 410 on its
 * route. Always rejects with `ENDPOINT_RETIRED` and sends no request. An
 * operator grants Enterprise as a trial or a contract. Removed in the next major.
 */
export async function setEnterpriseDemo(_accountId: string, _enabled: boolean): Promise<boolean> {
  throw retiredEndpointError('setEnterpriseDemo', PLAN_INSTEAD);
}
