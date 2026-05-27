// Sweeper for time-bounded V2 grants.
//
// The V2 engine already filters expired grants out of authorize() (the
// (expires_at IS NULL OR expires_at > now()) predicate on every query),
// so correctness doesn't depend on this job. What it adds:
//
//   1. An audit event for each grant that's just transitioned to
//      expired, so an admin reading the audit log can see WHY a member
//      lost access today.
//   2. A latch on the row (last_audited_at via updated_at touch) so the
//      same expiry isn't logged twice. We don't delete the row — the
//      grant stays visible in admin UIs as "Expired" until manually
//      removed, which preserves the audit trail.
//
// Cadence: every 60s. The two partial indexes on expires_at keep the
// scan cheap (only rows with a bounded grant are visited).
//
// Concurrency model: each tick uses a single UPDATE … RETURNING to
// atomically claim the rows it's going to audit. Postgres serializes
// per-row UPDATEs, so when N API replicas all run the sweeper at the
// same minute, every expired row ends up returned to EXACTLY ONE
// replica — no duplicate audit events. The previous SELECT-then-UPDATE
// pattern had a TOCTOU window that produced N audit events per row in
// a multi-replica deployment.

import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { projectGroupGrants, projectMembers } from '@kortix/db';
import { db } from '../shared/db';
import { recordAuditEvent } from '../shared/audit';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startGrantExpirySweeper(): void {
  if (timer) return;
  // Fire once on boot so an expiry that happened during downtime is
  // logged immediately rather than waiting up to a minute.
  void runOnce().catch((err) =>
    console.error('[iam expiry sweeper] tick failed', err),
  );
  timer = setInterval(() => {
    void runOnce().catch((err) =>
      console.error('[iam expiry sweeper] tick failed', err),
    );
  }, TICK_MS);
}

export function stopGrantExpirySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * One pass over both grant tables.
 *
 * For each table:
 *   1. UPDATE … RETURNING atomically claims every row that's both
 *      expired AND not yet audited (updated_at < expires_at).
 *   2. We then emit one audit event per returned row in parallel.
 *
 * The "newly expired" predicate is `expires_at < now() AND updated_at <
 * expires_at` — i.e. the row hasn't been touched since its own expiry.
 * Setting `updated_at = now()` in the UPDATE flips the latch so the
 * next tick (or another replica's concurrent tick) won't re-match.
 * Using SQL `now()` on both sides of the predicate AND the set keeps
 * the database clock as the single source of truth.
 *
 * If the audit insert fails, the row is already latched (updated_at is
 * past expires_at), so the next tick won't retry. That's deliberate:
 * we'd rather drop one audit event than spin re-trying forever and
 * spamming the log. Failures are surfaced via console.error.
 */
async function runOnce(): Promise<void> {
  // ── Direct project_members grants ──────────────────────────────────
  const claimedMembers = await db
    .update(projectMembers)
    .set({ updatedAt: sql`now()` })
    .where(
      and(
        isNotNull(projectMembers.expiresAt),
        lt(projectMembers.expiresAt, sql`now()`),
        lt(projectMembers.updatedAt, projectMembers.expiresAt),
      ),
    )
    .returning({
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      accountId: projectMembers.accountId,
      projectRole: projectMembers.projectRole,
      expiresAt: projectMembers.expiresAt,
    });

  await Promise.all(
    claimedMembers.map((m) =>
      recordAuditEvent({
        accountId: m.accountId,
        actorUserId: null, // system event
        action: 'iam.project.member.expired',
        resourceType: 'project_member',
        resourceId: `${m.projectId}:${m.userId}`,
        before: {
          project_role: m.projectRole,
          expires_at: m.expiresAt?.toISOString() ?? null,
        },
        after: null,
        ip: null,
        userAgent: 'system:expiry-sweeper',
      }).catch((err) =>
        console.error('[iam expiry sweeper] audit failed for member', err),
      ),
    ),
  );

  // ── Group-grant attachments ────────────────────────────────────────
  const claimedGrants = await db
    .update(projectGroupGrants)
    .set({ updatedAt: sql`now()` })
    .where(
      and(
        isNotNull(projectGroupGrants.expiresAt),
        lt(projectGroupGrants.expiresAt, sql`now()`),
        lt(projectGroupGrants.updatedAt, projectGroupGrants.expiresAt),
      ),
    )
    .returning({
      projectId: projectGroupGrants.projectId,
      groupId: projectGroupGrants.groupId,
      accountId: projectGroupGrants.accountId,
      role: projectGroupGrants.role,
      expiresAt: projectGroupGrants.expiresAt,
    });

  await Promise.all(
    claimedGrants.map((g) =>
      recordAuditEvent({
        accountId: g.accountId,
        actorUserId: null,
        action: 'iam.project.group.expired',
        resourceType: 'project_group_grant',
        resourceId: `${g.projectId}:${g.groupId}`,
        before: {
          role: g.role,
          expires_at: g.expiresAt?.toISOString() ?? null,
        },
        after: null,
        ip: null,
        userAgent: 'system:expiry-sweeper',
      }).catch((err) =>
        console.error('[iam expiry sweeper] audit failed for grant', err),
      ),
    ),
  );
}
