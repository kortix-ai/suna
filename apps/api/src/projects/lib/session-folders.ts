/**
 * Sidebar session folders — user-created groupings for a project's sessions.
 *
 * A folder is project-scoped and lives in `kortix.session_folders`; a session
 * points at it via `project_sessions.folder_id` (NULL = unfiled). Auto-folders
 * (Slack / Email / Scheduled / Webhooks) are virtual — the web client derives
 * them from `metadata.source` — so they never appear here.
 *
 * Sharing uses the SAME model as sessions (the common team-share system):
 *   'private'    — only the creator sees the folder;
 *   'project'    — every project member sees it;
 *   'restricted' — the creator + the members/groups in `session_folder_grants`.
 * Sessions inside a shared folder inherit that folder's audience (see
 * folderInheritedVisibilityFor + the sessions list/read routes).
 */
import type { SessionFolder } from '@kortix/api-contract';
import { sessionFolderGrants, sessionFolders } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import {
  type SecretGrant,
  type ShareSubject,
  type SharingIntent,
  sessionIntentToVisibility,
  visibilityToIntent,
} from '../../executor/share';
import { db } from '../../shared/db';

export type SessionFolderRow = typeof sessionFolders.$inferSelect;

export type FolderVisibility = 'private' | 'project' | 'restricted';

/** Pure: may this viewer SEE the folder in the sidebar? Owner always; project
 *  folders → everyone; restricted → members/groups in the allow-list. */
export function isFolderVisibleTo(
  row: Pick<SessionFolderRow, 'visibility' | 'createdBy'>,
  grants: SecretGrant[],
  subject: ShareSubject,
): boolean {
  if (row.createdBy && row.createdBy === subject.userId) return true;
  if (row.visibility === 'project') return true;
  if (row.visibility === 'restricted') {
    for (const g of grants) {
      if (g.principalType === 'member' && g.principalId === subject.userId) return true;
      if (g.principalType === 'group' && subject.groupIds.includes(g.principalId)) return true;
    }
  }
  return false;
}

/** Pure: may this viewer rename/share/delete the folder? */
export function canManageFolder(
  row: Pick<SessionFolderRow, 'createdBy'>,
  viewerId: string,
  canManageProject: boolean,
): boolean {
  if (canManageProject) return true;
  return !!row.createdBy && row.createdBy === viewerId;
}

/**
 * Pure: the folder ids whose sessions this viewer inherits access to. A session
 * filed in one of these folders is visible to the viewer even if the session's
 * own visibility is private — sharing the folder shares its contents. A private
 * folder grants nothing beyond its owner (who sees their own sessions anyway).
 */
export function inheritedFolderIdsFor(
  rows: Array<Pick<SessionFolderRow, 'folderId' | 'visibility' | 'createdBy'>>,
  grantsByFolder: Map<string, SecretGrant[]>,
  subject: ShareSubject,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.visibility === 'private') continue;
    if (isFolderVisibleTo(r, grantsByFolder.get(r.folderId) ?? [], subject)) out.add(r.folderId);
  }
  return out;
}

/** Validate an untrusted folder name → trimmed, length-capped, or null. */
export function parseFolderName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 120) return null;
  return name;
}

/** Map a sharing intent → persisted (visibility, grants) using the shared
 *  session mechanism (private | project | restricted+grants). */
export function folderIntentToVisibility(intent: SharingIntent): {
  visibility: FolderVisibility;
  grants: SecretGrant[];
} {
  return sessionIntentToVisibility(intent);
}

/** Bulk-load folder grants → map folderId → grants. */
export async function loadFolderGrants(folderIds: string[]): Promise<Map<string, SecretGrant[]>> {
  const out = new Map<string, SecretGrant[]>();
  if (folderIds.length === 0) return out;
  const rows = await db
    .select({
      folderId: sessionFolderGrants.folderId,
      principalType: sessionFolderGrants.principalType,
      principalId: sessionFolderGrants.principalId,
    })
    .from(sessionFolderGrants)
    .where(inArray(sessionFolderGrants.folderId, folderIds));
  for (const r of rows) {
    const list = out.get(r.folderId) ?? [];
    list.push({ principalType: r.principalType as 'member' | 'group', principalId: r.principalId });
    out.set(r.folderId, list);
  }
  return out;
}

/** Persist a folder's sharing: set visibility + replace its grants. */
export async function setFolderSharing(folderId: string, intent: SharingIntent): Promise<void> {
  const { visibility, grants } = sessionIntentToVisibility(intent);
  await db
    .update(sessionFolders)
    .set({ visibility, updatedAt: new Date() })
    .where(eq(sessionFolders.folderId, folderId));
  await db.delete(sessionFolderGrants).where(eq(sessionFolderGrants.folderId, folderId));
  if (grants.length > 0) {
    await db
      .insert(sessionFolderGrants)
      .values(
        grants.map((g) => ({
          folderId,
          principalType: g.principalType,
          principalId: g.principalId,
        })),
      );
  }
}

export function serializeSessionFolder(
  row: SessionFolderRow,
  ctx: { viewerId: string; canManageProject: boolean; grants?: SecretGrant[] },
): SessionFolder {
  const isOwner = !!row.createdBy && row.createdBy === ctx.viewerId;
  return {
    folder_id: row.folderId,
    project_id: row.projectId,
    account_id: row.accountId,
    name: row.name,
    visibility: row.visibility,
    sharing: visibilityToIntent(
      row.visibility as 'private' | 'project' | 'restricted',
      ctx.grants ?? [],
    ),
    position: row.position,
    created_by: row.createdBy,
    is_owner: isOwner,
    can_manage: isOwner || ctx.canManageProject,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
