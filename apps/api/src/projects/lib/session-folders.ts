/**
 * Sidebar session folders — user-created groupings for a project's sessions.
 *
 * A folder is project-scoped and lives in `kortix.session_folders`; a session
 * points at it via `project_sessions.folder_id` (NULL = unfiled). Auto-folders
 * (Slack / Email / Scheduled / Webhooks) are virtual — the web client derives
 * them from `metadata.source` — so they never appear here.
 *
 * Visibility reuses the session enum but only two values are accepted today:
 *   'private' — only the creator sees the folder (its sessions render unfiled
 *               for everyone else, still governed by their own visibility);
 *   'project' — every member sees the folder AND the sessions inside inherit
 *               project-wide visibility (folder sharing by inheritance; see
 *               folderInheritedSessionIds + the sessions list route).
 */
import type { SessionFolder } from '@kortix/api-contract';
import type { sessionFolders } from '@kortix/db';

export type SessionFolderRow = typeof sessionFolders.$inferSelect;

export type FolderVisibility = 'private' | 'project';

/** Pure: may this viewer see the folder at all? */
export function isFolderVisibleTo(
  row: Pick<SessionFolderRow, 'visibility' | 'createdBy'>,
  viewerId: string,
): boolean {
  if (row.visibility === 'project') return true;
  return !!row.createdBy && row.createdBy === viewerId;
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
 * Pure: the folder ids whose sessions inherit project-wide visibility. A
 * session in one of these folders is visible to every project member even if
 * its own visibility is 'private' — sharing the folder shares its contents.
 */
export function projectVisibleFolderIds(
  rows: Array<Pick<SessionFolderRow, 'folderId' | 'visibility'>>,
): Set<string> {
  return new Set(rows.filter((r) => r.visibility === 'project').map((r) => r.folderId));
}

/** Validate an untrusted visibility value; folders accept private|project only. */
export function parseFolderVisibility(value: unknown): FolderVisibility | null {
  return value === 'private' || value === 'project' ? value : null;
}

/** Validate an untrusted folder name → trimmed, length-capped, or null. */
export function parseFolderName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 120) return null;
  return name;
}

export function serializeSessionFolder(
  row: SessionFolderRow,
  ctx: { viewerId: string; canManageProject: boolean },
): SessionFolder {
  const isOwner = !!row.createdBy && row.createdBy === ctx.viewerId;
  return {
    folder_id: row.folderId,
    project_id: row.projectId,
    account_id: row.accountId,
    name: row.name,
    visibility: row.visibility,
    position: row.position,
    created_by: row.createdBy,
    is_owner: isOwner,
    can_manage: isOwner || ctx.canManageProject,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
