// A project's Files: one drive per project, a tree of folders, and access per
// folder (read, write or manage) for people, teams, agents and the whole
// project. Each person has their own folder, `/Users/<name>`, private until
// they share it and mounted as their desktop in their sessions.

import { ApiError, backendApi } from '../../http/api-client';
import { authenticatedFetch } from '../../http/auth';
import { platformConfig } from '../../http/config';
import { unwrap } from './shared';
import { stripTrailingSlashes } from '../../../platform/strings';

export type FolderLevel = 'read' | 'write' | 'manage';
export type FolderAccess = 'none' | FolderLevel;
export type FolderPrincipalType = 'user' | 'group' | 'agent' | 'project';

export interface Drive {
  driveId: string;
  accountId: string;
  projectId: string;
  kind: 'project';
  name: string;
  /** Null when the drive has no files yet or its size could not be read. */
  sizeBytes: number | null;
  sizeLimitBytes: number | null;
  fileCount: number | null;
  lastChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The caller's access at the top of the drive: `manage` for project admins. */
  access: FolderAccess;
  /** The caller's own folder, `/Users/<name>`. */
  personalFolder: string | null;
  /** "(conflict ...)" copies in folders the caller can see that nobody resolved or dismissed yet. */
  openConflicts?: number;
  /** Folders other people shared with the caller, outside their own folder. */
  sharedWithMe?: Array<{ path: string; access: FolderAccess }>;
}

export interface DriveEntry {
  path: string;
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
  /** What the caller may do with this entry. */
  access: FolderAccess;
  /** The folder has sharing of its own. */
  shared?: boolean;
}

export interface DriveVersion {
  id: string;
  createdAt: string;
  /** `created` (the empty drive), `edit` (a change made in Files), `sync` (changes from a session), `restore`. */
  kind: 'created' | 'edit' | 'sync' | 'restore';
  author: 'drive' | 'session' | 'system';
  changes: { changed: number; deleted: number };
}

/** One grant on a folder, or on a folder above it (`inherited`). */
export interface FolderGrant {
  grantId: string;
  path: string;
  inherited: boolean;
  /** Made by Kortix: a person's own folder, the default for Company. */
  system: boolean;
  principalType: FolderPrincipalType;
  principalId: string;
  label: string;
  level: FolderLevel;
}

export interface FolderAccessView {
  path: string;
  /** The caller's own access. */
  access: FolderAccess;
  /** The folder can be shared (not the top of Files, not /Users). */
  grantable: boolean;
  grants: FolderGrant[];
}

export interface FolderPrincipals {
  people: Array<{ id: string; label: string }>;
  teams: Array<{ id: string; label: string }>;
  /** `id` is the agent's name. */
  agents: Array<{ id: string; label: string }>;
}

/** A "(conflict ...)" copy kept beside `originalPath` when two writers changed it at once. */
export interface DriveConflict {
  conflictId: string;
  path: string;
  originalPath: string;
  detectedAt: string;
}

export interface SessionDrive {
  driveId: string;
  /** The folder, for people: "Company", "Users / ana". */
  name: string;
  kind: 'project';
  mountPath: string;
  readOnly: boolean;
  /** The folder of the drive this mount is. */
  subdir: string;
  /** `me`: the session owner's own folder, their desktop. */
  role?: 'me' | 'drive';
  openConflicts?: number;
}

export interface SessionDrives {
  drives: SessionDrive[];
  /** The session is its owner's own (private, started by them): their folder mounts in it. */
  personal: boolean;
  /** Folders the session should have that did not fit in its sandbox's mount slots. */
  skipped?: Array<{ driveId: string; name: string }>;
  /** What to tell people about `skipped`, or null when every folder fit. */
  skippedMessage?: string | null;
}

const drivePath = (driveId: string) => `/drives/${encodeURIComponent(driveId)}`;

/** The project's Files. Creates the drive and the caller's own folder on first use. */
export async function getProjectDrive(projectId: string): Promise<Drive> {
  const drives = unwrap(
    await backendApi.get<{ drives: Drive[] }>(`/drives?${new URLSearchParams({ projectId })}`),
    'Failed to load files',
  ).drives;
  if (!drives[0]) throw new ApiError('Files not found', { status: 404 });
  return drives[0];
}

/** Who has access to a folder: its own grants and the ones it inherits. */
export async function getFolderAccess(driveId: string, path: string): Promise<FolderAccessView> {
  return unwrap(
    await backendApi.get<FolderAccessView>(`${drivePath(driveId)}/access?${new URLSearchParams({ path })}`),
    'Failed to load sharing',
  );
}

/**
 * Share a folder: a person (user id), a team (group id), an agent (its name)
 * or everyone in the project. Sharing again changes the level.
 */
export async function shareFolder(
  driveId: string,
  input: { path: string; principalType: FolderPrincipalType; principalId?: string; level: FolderLevel },
): Promise<{ grantId: string; pendingSessions?: number }> {
  return unwrap(
    await backendApi.put<{ grantId: string; pendingSessions?: number }>(`${drivePath(driveId)}/access`, input),
    'Failed to share folder',
  );
}

/**
 * Stop sharing a folder. `pendingSessions`: running sessions that still mount
 * it because their detach has not landed yet. The API keeps retrying those and
 * refuses their access to it meanwhile; 0 means every session is in line.
 */
export async function unshareFolder(driveId: string, grantId: string): Promise<{ pendingSessions: number }> {
  const res = unwrap(
    await backendApi.delete<{ pendingSessions?: number } | null>(`${drivePath(driveId)}/access/${encodeURIComponent(grantId)}`),
    'Failed to stop sharing',
  );
  return { pendingSessions: typeof res?.pendingSessions === 'number' ? res.pendingSessions : 0 };
}

/** People, teams and agents a folder can be shared with. */
export async function listFolderPrincipals(driveId: string): Promise<FolderPrincipals> {
  return unwrap(await backendApi.get<FolderPrincipals>(`${drivePath(driveId)}/principals`), 'Failed to load people');
}

/** Conflict copies on the drive that are still open. */
export async function listDriveConflicts(driveId: string): Promise<DriveConflict[]> {
  return unwrap(
    await backendApi.get<{ conflicts: DriveConflict[] }>(`${drivePath(driveId)}/conflicts`),
    'Failed to load conflicts',
  ).conflicts;
}

/** Hide a conflict notice. The copy stays on the drive. */
export async function dismissDriveConflict(driveId: string, conflictId: string): Promise<void> {
  unwrap(
    await backendApi.post(`${drivePath(driveId)}/conflicts/${encodeURIComponent(conflictId)}/dismiss`, {}),
    'Failed to dismiss conflict',
  );
}

/** One folder's entries (not recursive): only what the caller may see, each with the caller's access. */
export async function listDriveFiles(driveId: string, path = '/'): Promise<DriveEntry[]> {
  return (await listDriveFolder(driveId, path)).entries;
}

/** One folder's entries and the caller's access to the folder itself. */
export async function listDriveFolder(driveId: string, path = '/'): Promise<{ entries: DriveEntry[]; access: FolderAccess }> {
  return unwrap(
    await backendApi.get<{ entries: DriveEntry[]; access: FolderAccess }>(`${drivePath(driveId)}/files?${new URLSearchParams({ path })}`),
    'Failed to load files',
  );
}

/**
 * The URL of a file's bytes. It needs the caller's bearer token, so a browser
 * link cannot open it directly: use {@link downloadDriveFile} for that.
 */
export function getDriveFileUrl(driveId: string, path: string, options?: { download?: boolean }): string {
  const base = stripTrailingSlashes(platformConfig().backendUrl);
  const query: Record<string, string> = { path };
  if (options?.download) query.download = '1';
  return `${base}${drivePath(driveId)}/files/content?${new URLSearchParams(query)}`;
}

export async function downloadDriveFile(driveId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await authenticatedFetch(getDriveFileUrl(driveId, path), { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(body?.message || 'Could not download file', { status: response.status });
  }
  return response.blob();
}

/** A file's bytes and the version they are (the ETag), for a later conditional save. */
export async function readDriveFile(
  driveId: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; version: string | null }> {
  const response = await authenticatedFetch(getDriveFileUrl(driveId, path), { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(body?.message || 'Could not download file', { status: response.status });
  }
  return { blob: await response.blob(), version: response.headers.get('etag') };
}

/**
 * Write a file (at most 64 MiB), replacing any file at `path`. With `ifMatch`
 * (the version it was read at), a file someone changed since is refused with
 * 409 `file_changed` instead of being overwritten.
 */
export async function uploadDriveFile(
  driveId: string,
  path: string,
  body: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>,
  options?: { signal?: AbortSignal; ifMatch?: string | null },
): Promise<{ path: string; size: number; version?: string }> {
  return unwrap(
    await backendApi.putRaw<{ path: string; size: number; version?: string }>(
      `${drivePath(driveId)}/files/content?${new URLSearchParams({ path })}`,
      body,
      { signal: options?.signal, ...(options?.ifMatch ? { headers: { 'If-Match': options.ifMatch } } : {}) },
    ),
    'Failed to upload file',
  );
}

export async function makeDriveFolder(driveId: string, path: string): Promise<{ path: string }> {
  return unwrap(
    await backendApi.post<{ path: string }>(`${drivePath(driveId)}/files/mkdir`, { path }),
    'Failed to create folder',
  );
}

/** Move or rename. An existing destination is refused (409). */
export async function moveDriveFile(driveId: string, from: string, to: string): Promise<{ from: string; to: string }> {
  return unwrap(
    await backendApi.post<{ from: string; to: string }>(`${drivePath(driveId)}/files/move`, { from, to }),
    'Failed to move',
  );
}

export async function deleteDriveFile(driveId: string, path: string, options?: { recursive?: boolean }): Promise<void> {
  const query: Record<string, string> = { path };
  if (options?.recursive) query.recursive = 'true';
  unwrap(await backendApi.delete(`${drivePath(driveId)}/files?${new URLSearchParams(query)}`), 'Failed to delete');
}

/** Newest first. */
export async function listDriveVersions(driveId: string): Promise<DriveVersion[]> {
  return unwrap(
    await backendApi.get<{ versions: DriveVersion[] }>(`${drivePath(driveId)}/versions`),
    'Failed to load versions',
  ).versions;
}

/** Make the drive's files equal a version's (project admins). Later versions stay in the history. */
export async function restoreDriveVersion(driveId: string, versionId: string): Promise<void> {
  unwrap(await backendApi.post(`${drivePath(driveId)}/restore`, { versionId }), 'Failed to restore version');
}

const sessionDrivesPath = (projectId: string, sessionId: string) =>
  `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/drives`;

/** The folders the session's current sandbox mounts, and where. */
export async function listSessionDrives(projectId: string, sessionId: string): Promise<SessionDrive[]> {
  return (await getSessionDrives(projectId, sessionId)).drives;
}

/** The session's folders, and whether it is its owner's own session. */
export async function getSessionDrives(projectId: string, sessionId: string): Promise<SessionDrives> {
  return unwrap(await backendApi.get<SessionDrives>(sessionDrivesPath(projectId, sessionId)), 'Failed to load session files');
}
