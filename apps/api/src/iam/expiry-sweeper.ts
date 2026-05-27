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

import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { projectGroupGrants, projectMembers, projects } from '@kortix/db';
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
 * One pass over both grant tables. Emits an audit event per newly-expired
 * row and bumps updated_at as a latch so the next pass skips it.
 *
 * The "newly expired" predicate is `expires_at < now() AND updated_at <
 * expires_at` — i.e. the row hasn't been touched since its own expiry.
 * That handles the natural case AND lets an admin's manual update
 * (changing role, etc.) reset the latch if they bump expires_at.
 */
async function runOnce(): Promise<void> {
  // ── Direct project_members grants ──────────────────────────────────
  const expiredMembers = await db
    .select({
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      accountId: projectMembers.accountId,
      projectRole: projectMembers.projectRole,
      expiresAt: projectMembers.expiresAt,
      // Pull project name for audit readability.
      projectName: projects.name,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.projectId, projectMembers.projectId))
    .where(
      and(
        isNotNull(projectMembers.expiresAt),
        lt(projectMembers.expiresAt, sql`now()`),
        // Latch: skip rows we've already audited (updated_at was bumped
        // past the expiry timestamp on the previous tick).
        lt(projectMembers.updatedAt, projectMembers.expiresAt),
      ),
    );

  for (const m of expiredMembers) {
    await recordAuditEvent({
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
    );
    // Latch — bumps updated_at so we don't re-log this expiry.
    await db
      .update(projectMembers)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(projectMembers.projectId, m.projectId),
          eq(projectMembers.userId, m.userId),
        ),
      );
  }

  // ── Group-grant attachments ────────────────────────────────────────
  const expiredGrants = await db
    .select({
      projectId: projectGroupGrants.projectId,
      groupId: projectGroupGrants.groupId,
      accountId: projectGroupGrants.accountId,
      role: projectGroupGrants.role,
      expiresAt: projectGroupGrants.expiresAt,
    })
    .from(projectGroupGrants)
    .where(
      and(
        isNotNull(projectGroupGrants.expiresAt),
        lt(projectGroupGrants.expiresAt, sql`now()`),
        lt(projectGroupGrants.updatedAt, projectGroupGrants.expiresAt),
      ),
    );

  for (const g of expiredGrants) {
    await recordAuditEvent({
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
    );
    await db
      .update(projectGroupGrants)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(projectGroupGrants.projectId, g.projectId),
          eq(projectGroupGrants.groupId, g.groupId),
        ),
      );
  }

}
