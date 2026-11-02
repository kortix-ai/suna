// A project admin opening another person's own folder (`/Users/<name>`).
// Admins reach every person's folder (2026-11-02); the owner sees each admin
// who did, per day, and every open leaves an audit event.

import { driveFolderAdminReads } from '@kortix/db';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { recordAuditEvent } from '../shared/audit';

/** The audit action of an admin's open of another person's folder. */
export const DRIVE_ADMIN_ACCESS_ACTION = 'drive.folder.admin_access';

/** How far back the owner's list reaches. */
const ADMIN_READS_DAYS = 90;
/**
 * One open per (folder, admin) per this window: browsing a folder lists it,
 * polls it and fetches each thumbnail, which is one visit, not dozens. The
 * audit log gets one event per counted open too.
 */
const OPEN_WINDOW = sql`interval '10 minutes'`;

export interface AdminFolderAccess {
  driveId: string;
  accountId: string;
  projectId: string;
  /** The person's own folder, `/Users/<name>`. */
  folder: string;
  /** What the admin opened: the folder itself or a path inside it. */
  path: string;
  adminUserId: string;
  /** `read`, `write` or `manage`: what the request did there. */
  level: string;
}

/**
 * Record an open: the day's row for (folder, admin), counted once per
 * 10 minutes, and an audit event for each counted open. Never throws.
 */
export async function noteAdminFolderAccess(access: AdminFolderAccess): Promise<void> {
  try {
    const counted = await db
      .insert(driveFolderAdminReads)
      .values({ driveId: access.driveId, folder: access.folder, adminUserId: access.adminUserId, day: sql`(now() at time zone 'utc')::date` })
      .onConflictDoUpdate({
        target: [driveFolderAdminReads.driveId, driveFolderAdminReads.folder, driveFolderAdminReads.adminUserId, driveFolderAdminReads.day],
        set: { lastAt: sql`now()`, opens: sql`${driveFolderAdminReads.opens} + 1` },
        setWhere: sql`${driveFolderAdminReads.lastAt} < now() - ${OPEN_WINDOW}`,
      })
      .returning({ opens: driveFolderAdminReads.opens });
    if (counted.length === 0) return;
    await recordAuditEvent({
      accountId: access.accountId,
      projectId: access.projectId,
      actorUserId: access.adminUserId,
      actorType: 'human',
      action: DRIVE_ADMIN_ACCESS_ACTION,
      resourceType: 'drive_folder',
      resourceId: access.driveId,
      outcome: 'success',
      metadata: { folder: access.folder, path: access.path, level: access.level },
    });
  } catch (err) {
    logger.error('[drives] could not record an admin open of a personal folder', { folder: access.folder, err });
  }
}

export interface AdminFolderRead {
  adminUserId: string;
  day: string;
  firstAt: string;
  lastAt: string;
  opens: number;
}

/** The admins who opened `folder`, newest first, over the last 90 days. */
export async function listAdminFolderReads(driveId: string, folder: string): Promise<AdminFolderRead[]> {
  const rows = await db
    .select()
    .from(driveFolderAdminReads)
    .where(
      and(
        eq(driveFolderAdminReads.driveId, driveId),
        eq(driveFolderAdminReads.folder, folder),
        gte(driveFolderAdminReads.day, sql`((now() at time zone 'utc')::date - ${ADMIN_READS_DAYS}::int)`),
      ),
    )
    .orderBy(desc(driveFolderAdminReads.lastAt))
    .limit(200);
  return rows.map((r) => ({
    adminUserId: r.adminUserId,
    day: r.day,
    firstAt: r.firstAt.toISOString(),
    lastAt: r.lastAt.toISOString(),
    opens: r.opens,
  }));
}
