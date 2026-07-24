import type { AuditEventInput } from '../shared/audit';

export const MAX_ACCOUNT_SESSION_LIMIT = 100_000;

const VALIDATION_MESSAGE = `max_concurrent_sessions must be null or an integer from 1 to ${MAX_ACCOUNT_SESSION_LIMIT}`;

export function parseAccountSessionLimit(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_ACCOUNT_SESSION_LIMIT
  ) {
    throw new Error(VALIDATION_MESSAGE);
  }
  return value;
}

interface SetAccountSessionLimitInput {
  accountId: string;
  actorUserId: string | null;
  maxConcurrentSessions: unknown;
  ip: string | null;
  userAgent: string | null;
}

interface SetAccountSessionLimitDependencies {
  getCurrent(): Promise<number | null>;
  persist(accountId: string, value: number | null): Promise<void>;
  clearCache(): void;
  recordAudit(event: AuditEventInput): Promise<void>;
}

export async function setAccountSessionLimit(
  input: SetAccountSessionLimitInput,
  dependencies: SetAccountSessionLimitDependencies,
): Promise<{ previous: number | null; current: number | null }> {
  const current = parseAccountSessionLimit(input.maxConcurrentSessions);
  const previous = await dependencies.getCurrent();

  await dependencies.persist(input.accountId, current);
  dependencies.clearCache();

  try {
    await dependencies.recordAudit({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      action: 'admin.account.session_limit.set',
      resourceType: 'credit_account',
      resourceId: input.accountId,
      before: { max_concurrent_sessions: previous },
      after: { max_concurrent_sessions: current },
      ip: input.ip,
      userAgent: input.userAgent,
    });
  } catch (error) {
    console.error('[admin] Failed to record account session-limit audit event:', error);
  }

  return { previous, current };
}
