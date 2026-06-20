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

export function getUpgradeGate(error: unknown): UpgradeGate | null {
  if (!error || typeof error !== 'object') return null;

  const candidate = error as Partial<ApiRequestError>;
  if (candidate.status !== 402 || !UPGRADE_GATE_REASONS.includes(candidate.code as UpgradeGateReason)) {
    return null;
  }

  return {
    reason: candidate.code as UpgradeGateReason,
    ...(candidate.accountId ? { accountId: candidate.accountId } : {}),
    message: candidate.message || 'Upgrade your plan to continue.',
  };
}
