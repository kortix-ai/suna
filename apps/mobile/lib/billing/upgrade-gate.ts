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

interface ApiErrorBody {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
  code?: unknown;
  account_id?: unknown;
  balance?: unknown;
}

export interface UpgradeGate {
  reason: UpgradeGateReason;
  accountId?: string;
  message: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asApiErrorBody(value: unknown): ApiErrorBody {
  return value && typeof value === 'object' ? (value as ApiErrorBody) : {};
}

export function createApiRequestError(
  status: number,
  body: unknown,
  fallbackMessage = `Request failed (${status})`,
): ApiRequestError {
  const payload = asApiErrorBody(body);
  const error = new Error(
    readString(payload.error) ?? readString(payload.message) ?? readString(payload.detail) ?? fallbackMessage,
  ) as ApiRequestError;
  error.name = 'ApiRequestError';
  error.status = status;
  error.code = readString(payload.code);
  error.accountId = readString(payload.account_id);
  error.balance = readNumber(payload.balance);
  return error;
}

/**
 * `@kortix/sdk`'s `backendApi`/`projects-client` throws a different error
 * shape than mobile's own `apiFetch` + `createApiRequestError`: a 402 comes
 * back as a `BillingError` with `.status` + `.message` at the top level, but
 * `code` / `account_id` / `balance` nested one level down under `.detail`
 * (see `packages/sdk/src/platform/api/errors.ts#parseBillingError` — it
 * spreads the backend's `{code, balance, account_id}` body into
 * `BillingError.detail`, not onto the error object itself). Mobile's own
 * `createApiRequestError` puts them flat on the error. Read both shapes so
 * this keeps working for code paths now backed by the SDK (e.g.
 * `lib/projects/projects-client.ts`'s SDK-re-exported functions) as well as
 * the mobile-native ones (`startProjectSession`, `lib/platform/client.ts`).
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
