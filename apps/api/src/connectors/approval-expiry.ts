/**
 * Approval expiry: a pending connector approval (`status='pending_approval'`)
 * stops being decidable at `expires_at`. The gateway does not wait on the
 * decision, so expiry is a state change only — it never resumes a session.
 *
 * `expires_at` is NULL on rows written before expiry shipped: those never expire.
 */
import { connectorCalls } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger';

export const DEFAULT_APPROVAL_TTL_SECONDS = 24 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const UNIT_SECONDS = { m: 60, h: 3_600, d: 86_400 } as const;

/**
 * `approvals.ttl` from kortix.yaml: an integer and a unit in {m,h,d} (`30m`,
 * `4h`, `7d`), clamped to [5m, 30d]. Absent → null (the 24 h default). Any
 * other value → null and one warn log: a typo must not break the project.
 */
export function parseApprovalTtl(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const match = typeof raw === 'string' ? /^(\d+)([mhd])$/.exec(raw.trim()) : null;
  if (!match) {
    logger.warn('[approvals] invalid approvals.ttl in kortix.yaml; using the 24h default', {
      value: String(raw).slice(0, 64),
    });
    return null;
  }
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, seconds));
}

/** SQL: the row has not passed its `expires_at` (database clock). */
export const approvalNotExpired = sql`(${connectorCalls.expiresAt} is null or ${connectorCalls.expiresAt} > now())`;

/** True when the call can no longer be decided because its window closed. */
export function isApprovalExpired(
  row: { status: string; expiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (row.status === 'expired') return true;
  return row.status === 'pending_approval' && row.expiresAt !== null && row.expiresAt <= now;
}
