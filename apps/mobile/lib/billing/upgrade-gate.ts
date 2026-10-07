export const UPGRADE_GATE_REASONS = [
  'subscription_required',
  'insufficient_credits',
  'no_account',
] as const;

export type UpgradeGateReason = (typeof UPGRADE_GATE_REASONS)[number];

export interface ApiRequestError extends Error {
  status: number;
  code?: string;
  accountId?: string;
  balance?: number;
}

export interface UpgradeGate {
  reason: UpgradeGateReason;
  accountId?: string;
  message: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * A 402 from `@kortix/sdk` is a `BillingError`: `.status` and `.message` at the
 * top level, the backend's `{ code, account_id, balance }` body under `.detail`
 * (`parseBillingError`, packages/sdk/src/core/http/api/errors.ts). Flat
 * `code` / `accountId` are read too.
 */
interface SdkBillingErrorLike {
  status?: number;
  message?: string;
  detail?: { code?: unknown; account_id?: unknown; balance?: unknown; message?: unknown };
}

export function getUpgradeGate(error: unknown): UpgradeGate | null {
  if (!error || typeof error !== 'object') return null;

  const candidate = error as Partial<ApiRequestError> & SdkBillingErrorLike;
  if (candidate.status !== 402) return null;

  const flatCode = candidate.code;
  const detail = candidate.detail;
  const code = (flatCode ?? detail?.code) as UpgradeGateReason | undefined;
  if (!code || !UPGRADE_GATE_REASONS.includes(code)) return null;

  const accountId = candidate.accountId ?? readString(detail?.account_id);
  const message =
    candidate.message ||
    readString(detail?.message) ||
    'Upgrade your plan to continue.';

  return {
    reason: code,
    ...(accountId ? { accountId } : {}),
    message,
  };
}
