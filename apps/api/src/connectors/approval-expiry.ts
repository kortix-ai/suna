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
 * How long an approve lets the identical call run once, counted from the decision.
 * Long enough for the approve → resume → repeat round trip; short enough that a stale yes cannot authorize a much later call.
 */
export const APPROVAL_RERUN_WINDOW_MS = 15 * 60 * 1000;

// apps/cli/src/commands/connector-gateway.ts holds a copy for the CLI; change both together.
/** The rule for a gate WITHOUT a held input (a dashboard JWT, an unscoped PAT): the caller repeats the call. */
export const APPROVAL_RERUN_RULE = `Approval alone does not run the call: after approval, repeat this exact call (same arguments and account) within ${APPROVAL_RERUN_WINDOW_MS / 60_000} minutes, and it runs once.`;

/**
 * The rule for a gate WITH a held input: Kortix runs the call after approval.
 * A session is resumed with the result; a sessionless caller reads it by id.
 */
export function heldRunRule(gate: { projectId: string; executionId: string; sessionId: string | null }): string {
  return gate.sessionId
    ? 'Kortix runs this exact call once a human approves, then resumes the session with the result. A denial resumes it too. Do not repeat the call.'
    : `Kortix runs this exact call once a human approves. Do not repeat the call. Read the outcome at GET /v1/projects/${gate.projectId}/review/items/call:${gate.executionId}.`;
}

/** The answer to a repeat of a call that is already held, queued or running. */
export function heldCallRepeatInstructions(gate: { projectId: string; executionId: string; sessionId: string | null }): string {
  return `This exact call is already waiting for approval or running. ${heldRunRule(gate)}${gate.sessionId ? ' Stop this turn.' : ''}`;
}

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
