// Drives — shared folders that sessions mount and people browse. A personal
// drive belongs to one user, an agent drive to one project agent, a company
// drive to the account (attached to projects by a grant).

import { ApiError, backendApi } from '../../http/api-client';
import { authenticatedFetch } from '../../http/auth';
import { platformConfig } from '../../http/config';
import { unwrap } from './shared';

export type DriveKind = 'personal' | 'agent' | 'company';
export type DriveGrantAccess = 'read' | 'write';

export interface Drive {
  driveId: string;
  accountId: string;
  kind: DriveKind;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  agentName: string | null;
  isDefault: boolean;
  /** Null when the drive has no files yet or its size could not be read. */
  sizeBytes: number | null;
  fileCount: number | null;
  lastChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Where a session sees the drive, e.g. `/drives/me`. */
  mountPath: string;
  /** The size cap of the drive's storage, when known. */
  sizeLimitBytes?: number | null;
  /** What the caller may do: `read`, `write` (files) or `manage` (also rename, delete and grant). */
  access: 'read' | 'write' | 'manage';
  /** A personal drive someone else owns and shared with the caller. */
  shared?: boolean;
  /** Who shared it, for a shared drive. */
  ownerEmail?: string | null;
  /** "(conflict ...)" copies on the drive that nobody resolved or dismissed yet. */
  openConflicts?: number;
  /** Company drives listed for a project: that project's grant, or null when it has none. */
  projectAccess?: DriveGrantAccess | null;
  /** Company drives listed for a project: the grants to that project's agents. */
  agentGrants?: Array<{ agentName: string; access: DriveGrantAccess }>;
}

export interface DriveEntry {
  path: string;
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
}

export interface DriveVersion {
  id: string;
  createdAt: string;
  /** `created` (the empty drive), `edit` (a change made in Drive), `sync` (changes from a session), `restore`. */
  kind: 'created' | 'edit' | 'sync' | 'restore';
  author: 'drive' | 'session' | 'system';
  changes: { changed: number; deleted: number };
}

/**
 * Where a drive mounts beyond its owner's sessions: every session of a
 * project, every session a person starts, or every session of one agent.
 * On a personal drive, `user` is a share and an `agent` grant with `write`
 * lets that agent write the whole drive in the owner's sessions.
 */
export type DriveGrantSubject =
  | { type: 'project'; projectId: string }
  | { type: 'user'; userId: string }
  | { type: 'agent'; projectId: string; agentName: string };

export interface DriveGrant {
  grantId: string;
  type: DriveGrantSubject['type'];
  projectId: string | null;
  projectName: string | null;
  userId: string | null;
  userEmail: string | null;
  agentName: string | null;
  access: DriveGrantAccess;
  createdAt: string;
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
  name: string;
  kind: DriveKind;
  mountPath: string;
  readOnly: boolean;
  /** Only this folder of the drive is mounted (the "From agents" folder). */
  subdir?: string;
  /** The writable "From agents" folder of the session owner's drive. */
  fromAgents?: boolean;
  /** `me`: the session owner's own drive; `agent`: the session agent's drive. */
  role?: 'me' | 'agent' | 'drive';
  openConflicts?: number;
  /** Set for a personal drive someone shared into the session. */
  ownerEmail?: string;
}

export interface SessionDrives {
  drives: SessionDrive[];
  /** The session is its owner's own (private, started by them): their drives mount in it. */
  personal: boolean;
}

export interface SessionDriveChange extends SessionDrives {
  /** False when the session is not running: the change applies when it next starts. */
  live: boolean;
}

const drivePath = (driveId: string) => `/drives/${encodeURIComponent(driveId)}`;

/** The caller's drives. Creates their default personal drive on first use. */
export async function listDrives(scope?: { projectId?: string; accountId?: string }): Promise<Drive[]> {
  const query: Record<string, string> = {};
  if (scope?.projectId) query.projectId = scope.projectId;
  else if (scope?.accountId) query.account_id = scope.accountId;
  const qs = Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  return unwrap(await backendApi.get<{ drives: Drive[] }>(`/drives${qs}`), 'Failed to load drives').drives;
}

export async function createDrive(input: {
  name: string;
  kind: 'personal' | 'company';
  accountId?: string;
}): Promise<Drive> {
  return unwrap(
    await backendApi.post<Drive>('/drives', {
      name: input.name,
      kind: input.kind,
      ...(input.accountId ? { account_id: input.accountId } : {}),
    }),
    'Failed to create drive',
  );
}

export async function renameDrive(driveId: string, name: string): Promise<Drive> {
  return unwrap(await backendApi.patch<Drive>(drivePath(driveId), { name }), 'Failed to rename drive');
}

/** Deletes the drive and every file in it. */
export async function deleteDrive(driveId: string): Promise<void> {
  unwrap(await backendApi.delete(drivePath(driveId)), 'Failed to delete drive');
}

/** Grant a drive to a project, a person or an agent. Granting the same subject again changes its access. */
export async function grantDrive(
  driveId: string,
  subject: DriveGrantSubject,
  access: DriveGrantAccess = 'write',
): Promise<DriveGrant> {
  return unwrap(
    await backendApi.post<DriveGrant>(`${drivePath(driveId)}/grants`, { ...subject, access }),
    'Failed to grant drive',
  );
}

/** Remove the grant to one subject. */
export async function revokeDrive(driveId: string, subject: DriveGrantSubject): Promise<void> {
  const query: Record<string, string> =
    subject.type === 'user'
      ? { userId: subject.userId }
      : subject.type === 'agent'
        ? { projectId: subject.projectId, agentName: subject.agentName }
        : { projectId: subject.projectId };
  unwrap(await backendApi.delete(`${drivePath(driveId)}/grants?${new URLSearchParams(query)}`), 'Failed to remove grant');
}

/** Remove one grant by id. */
export async function removeDriveGrant(driveId: string, grantId: string): Promise<void> {
  unwrap(await backendApi.delete(`${drivePath(driveId)}/grants/${encodeURIComponent(grantId)}`), 'Failed to remove grant');
}

/** Where the drive is granted. Needs manage access to the drive. */
export async function listDriveGrants(driveId: string): Promise<DriveGrant[]> {
  return unwrap(await backendApi.get<{ grants: DriveGrant[] }>(`${drivePath(driveId)}/grants`), 'Failed to load grants')
    .grants;
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

/** One folder's entries (not recursive). */
export async function listDriveFiles(driveId: string, path = '/'): Promise<DriveEntry[]> {
  return unwrap(
    await backendApi.get<{ entries: DriveEntry[] }>(`${drivePath(driveId)}/files?${new URLSearchParams({ path })}`),
    'Failed to load files',
  ).entries;
}

/**
 * The URL of a file's bytes. It needs the caller's bearer token, so a browser
 * link cannot open it directly: use {@link downloadDriveFile} for that.
 */
export function getDriveFileUrl(driveId: string, path: string, options?: { download?: boolean }): string {
  const base = platformConfig().backendUrl.replace(/\/+$/, '');
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

/** Write a file (at most 64 MiB), replacing any file at `path`. */
export async function uploadDriveFile(
  driveId: string,
  path: string,
  body: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>,
  options?: { signal?: AbortSignal },
): Promise<{ path: string; size: number }> {
  return unwrap(
    await backendApi.putRaw<{ path: string; size: number }>(
      `${drivePath(driveId)}/files/content?${new URLSearchParams({ path })}`,
      body,
      { signal: options?.signal },
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

/** Make the drive's files equal a version's. Later versions stay in the history. */
export async function restoreDriveVersion(driveId: string, versionId: string): Promise<Drive> {
  return unwrap(
    await backendApi.post<Drive>(`${drivePath(driveId)}/restore`, { versionId }),
    'Failed to restore version',
  );
}

const sessionDrivesPath = (projectId: string, sessionId: string) =>
  `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/drives`;

/** The drives the session's current sandbox mounts, and where. */
export async function listSessionDrives(projectId: string, sessionId: string): Promise<SessionDrive[]> {
  return (await getSessionDrives(projectId, sessionId)).drives;
}

/** The session's drives, and whether it is its owner's own session. */
export async function getSessionDrives(projectId: string, sessionId: string): Promise<SessionDrives> {
  return unwrap(await backendApi.get<SessionDrives>(sessionDrivesPath(projectId, sessionId)), 'Failed to load session drives');
}

/**
 * Attach a drive to a session: mounted in the running sandbox now and in
 * every later sandbox of the session. A personal drive attaches only to its
 * holder's own private session.
 */
export async function attachSessionDrive(
  projectId: string,
  sessionId: string,
  input: { driveId: string; readOnly?: boolean },
): Promise<SessionDriveChange> {
  return unwrap(
    await backendApi.post<SessionDriveChange>(sessionDrivesPath(projectId, sessionId), input),
    'Failed to attach drive',
  );
}

/** Take a drive out of a session, now and for every later sandbox of it. */
export async function detachSessionDrive(projectId: string, sessionId: string, driveId: string): Promise<SessionDriveChange> {
  return unwrap(
    await backendApi.delete<SessionDriveChange>(`${sessionDrivesPath(projectId, sessionId)}/${encodeURIComponent(driveId)}`),
    'Failed to detach drive',
  );
}

/**
 * Switch a session's drive between read-only and read-write. `write` on your
 * own drive is the per-session full-write opt-in.
 */
export async function setSessionDriveAccess(
  projectId: string,
  sessionId: string,
  driveId: string,
  access: DriveGrantAccess,
): Promise<SessionDriveChange> {
  return unwrap(
    await backendApi.patch<SessionDriveChange>(`${sessionDrivesPath(projectId, sessionId)}/${encodeURIComponent(driveId)}`, {
      access,
    }),
    'Failed to change drive access',
  );
}
