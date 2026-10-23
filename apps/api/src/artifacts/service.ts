// Artifacts (flag `artifacts`): paths in the project's Files volume shared as
// a doc (a Markdown file) or a page (an HTML file, or a folder with
// index.html). The bytes are plain files in Files; agents and people write
// them like any file. History is the volume's commit log, restricted to the
// commits that changed the artifact's entry file. The `artifacts` row only says
// that a path is shared, how, and with whom.
//
// Who may do what (the routes enforce the project leaves first):
//   view   the creator, anyone in shared_with_user_ids, every project member
//          when visibility is `project` or `public`, anyone with the link
//          when `public` (the content server)
//   edit   who may write the path in Files (the folder rules of the drive)
//   share  the creator, or project.write
import { artifacts } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { signStableChannelState } from '../channels/core/signed-state';
import { db } from '../shared/db';
import { normalizeDrivePath } from '../drives/access';
import { folderAccess, folderAccessAtLeast, type FolderLevel } from '../drives/folders';
import { ensurePersonalFolder, ensureProjectDrive, getDrive, listFolderGrants, readDriveVolume, writeDriveVolume, type DriveRow } from '../drives/service';
import {
  DriveStorageError,
  listVolumeCommits,
  listVolumeFiles,
  readVolumeFile,
  statVolumeFile,
  writeVolumeFile,
} from '../drives/volumes';
import { ARTIFACT_TYPE_KEYS, docTitle, htmlTitle, typeOfEntry, type ArtifactType } from './formats';

export const ARTIFACTS_FLAG = 'artifacts' as const;
export const ARTIFACT_VISIBILITIES = ['private', 'project', 'public'] as const;
export type ArtifactVisibility = (typeof ARTIFACT_VISIBILITIES)[number];
export type ArtifactRow = typeof artifacts.$inferSelect;
export type { ArtifactType };

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_PUBLISH_BYTES = 32 * 1024 * 1024;
/** How far back the history reads the Files commit log. */
const HISTORY_COMMITS = 200;
const ENTRIES = ['index.md', 'index.html'] as const;

// Content URLs: served by artifacts/content-routes.ts. A view URL is valid for
// 12–18 h and stays the same within each 6 h window, so a refetch never
// reloads an open page.
const VIEW_TTL_MS = 12 * 60 * 60_000;
const VIEW_WINDOW_MS = 6 * 60 * 60_000;

function apiBase(): string {
  // Unset values are '' in config, so `||`: an empty string must fall through.
  return (config.ARTIFACT_CONTENT_URL || config.KORTIX_URL || 'http://localhost:8008').replace(/\/+$/, '');
}

/** A signed URL that shows the artifact: as it was at `commit`, or now when null. */
export function artifactViewUrl(artifactId: string, commit: string | null): string {
  const exp = Math.ceil((Date.now() + VIEW_TTL_MS) / VIEW_WINDOW_MS) * VIEW_WINDOW_MS;
  return `${apiBase()}/v1/artifacts/s/${signStableChannelState('artifact-view', { a: artifactId, c: commit }, exp)}/`;
}

/** The public URL of the raw page (no Kortix chrome). */
export function artifactPublicContentUrl(artifactId: string): string {
  return `${apiBase()}/v1/artifacts/p/${artifactId}/`;
}

export class ArtifactError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413, message: string, readonly code?: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

const TYPES_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', wasm: 'application/wasm',
};

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPES_BY_EXT[ext] ?? 'application/octet-stream';
}

export function isTextType(contentType: string): boolean {
  return /^text\/|json|xml|svg|javascript/.test(contentType);
}

/** A file path inside an artifact folder: relative, no `.`/`..`/empty segment. Null when it cannot be one. */
export function normalizeArtifactPath(raw: string): string | null {
  const value = raw.trim().replace(/^\/+/, '');
  if (!value || value.length > 512 || value.includes('\0') || value.includes('\\')) return null;
  const parts = value.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  return parts.join('/');
}

const join = (folder: string, rel: string) => (folder === '/' ? `/${rel}` : `${folder}/${rel}`);

/** The entry file's path in Files. */
export function entryPath(row: Pick<ArtifactRow, 'root' | 'entry'>): string {
  return join(row.root, row.entry);
}

/** The Files path the artifact shares: its folder, or its single file. */
export function sharedPath(row: Pick<ArtifactRow, 'root' | 'entry' | 'folder'>): string {
  return row.folder ? row.root : entryPath(row);
}

export interface FileInput {
  /** UTF-8 text. */
  content?: string;
  /** Bytes, base64. */
  content_base64?: string;
}

export interface Author {
  userId: string;
  sessionId: string | null;
}

/** Who asks, as the Files folder rules see them. ponytail: group grants are not resolved here; add groupIds if teams share artifact folders. */
export interface Viewer {
  userId: string;
  projectWrite: boolean;
}

async function accessAt(drive: DriveRow, path: string, viewer: Viewer, level: FolderLevel): Promise<boolean> {
  const access = folderAccess(path, await listFolderGrants(drive), { userId: viewer.userId, projectMember: true, admin: viewer.projectWrite });
  return folderAccessAtLeast(access, level);
}

function decodeFile(path: string, file: FileInput): Uint8Array<ArrayBuffer> {
  if (typeof file.content === 'string') return new Uint8Array(Buffer.from(file.content, 'utf8'));
  if (typeof file.content_base64 === 'string') return new Uint8Array(Buffer.from(file.content_base64, 'base64'));
  throw new ArtifactError(400, `File ${path} needs content or content_base64`, 'invalid_file');
}

function encodeFiles(files: Record<string, FileInput>) {
  const out: Array<{ rel: string; bytes: Uint8Array<ArrayBuffer> }> = [];
  let total = 0;
  for (const [raw, file] of Object.entries(files)) {
    const rel = normalizeArtifactPath(raw);
    if (!rel) throw new ArtifactError(400, `Invalid file path: ${raw}`, 'invalid_path');
    const bytes = decodeFile(rel, file);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ArtifactError(413, `${rel} is larger than 16 MB`, 'file_too_large');
    total += bytes.byteLength;
    out.push({ rel, bytes });
  }
  if (total > MAX_PUBLISH_BYTES) throw new ArtifactError(413, 'One publish carries at most 32 MB', 'publish_too_large');
  // The entry last, so a reader never sees it before its assets.
  return out.sort((a, b) => Number(ENTRIES.includes(a.rel as never)) - Number(ENTRIES.includes(b.rel as never)));
}

function titleOf(type: ArtifactType, text: string): string | null {
  return type === 'doc' ? docTitle(text) : htmlTitle(text);
}

function slugify(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

async function exists(volume: string, path: string): Promise<boolean> {
  try {
    await statVolumeFile(volume, path);
    return true;
  } catch (err) {
    if (err instanceof DriveStorageError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Publish new files as an artifact in the author's own folder in Files: a
 * folder `/Users/<them>/Artifacts/<slug>/` with `index.md` or `index.html`
 * and everything beside it (a doc's images and videos land there too).
 */
export async function publishNew(
  scope: { accountId: string; projectId: string },
  author: Author,
  input: { title?: string; description?: string | null; visibility?: ArtifactVisibility; files: Record<string, FileInput> },
): Promise<ArtifactRow> {
  const files = encodeFiles(input.files);
  const entry = ENTRIES.find((e) => files.some((f) => f.rel === e));
  if (!entry) throw new ArtifactError(400, 'An artifact needs an index.md (a doc) or an index.html (a page)', 'missing_entry');
  const type = typeOfEntry(entry)!;
  const entryText = new TextDecoder().decode(files.find((f) => f.rel === entry)!.bytes);
  const title = input.title?.trim() || titleOf(type, entryText) || 'Untitled';
  const drive = await ensureProjectDrive(scope.accountId, scope.projectId);
  const home = await ensurePersonalFolder(drive, author.userId);
  const root = await writeDriveVolume(drive, async (volume) => {
    const base = join(join(home, 'Artifacts'), slugify(title));
    let candidate = base;
    for (let n = 2; await exists(volume, candidate); n++) candidate = `${base}-${n}`;
    for (const f of files) await writeVolumeFile(volume, join(candidate, f.rel), f.bytes, { overwrite: false });
    return candidate;
  });
  const [row] = await db.insert(artifacts).values({
    projectId: scope.projectId, accountId: scope.accountId, driveId: drive.driveId,
    root, entry, folder: true, title, type,
    description: input.description ?? null, visibility: input.visibility ?? 'private',
    createdByUserId: author.userId, createdBySessionId: author.sessionId,
  }).returning();
  return row!;
}

/**
 * Share a path that is already in Files: a `.md` or `.html` file, or a folder
 * with an index.md or index.html. The caller must be able to read it.
 */
export async function share(
  scope: { accountId: string; projectId: string },
  author: Author,
  viewer: Viewer,
  input: { path: string; title?: string; description?: string | null; visibility?: ArtifactVisibility },
): Promise<ArtifactRow> {
  const path = normalizeDrivePath(input.path);
  if (!path || path === '/') throw new ArtifactError(400, 'Name a file or a folder in Files', 'invalid_path');
  const drive = await ensureProjectDrive(scope.accountId, scope.projectId);
  if (!(await accessAt(drive, path, viewer, 'read'))) throw new ArtifactError(404, 'File or folder not found', 'not_found');
  const target = await readDriveVolume(drive, async (volume) => {
    const stat = await statVolumeFile(volume, path).catch((err) => {
      if (err instanceof DriveStorageError && err.status === 404) return null;
      throw err;
    });
    if (!stat) return null;
    if (stat.type === 'dir') {
      for (const e of ENTRIES) if (await exists(volume, join(path, e))) return { root: path, entry: e, folder: true };
      throw new ArtifactError(400, 'A folder needs an index.md or an index.html to be an artifact', 'missing_entry');
    }
    const name = path.split('/').pop()!;
    if (!typeOfEntry(name)) throw new ArtifactError(400, 'Share a .md or .html file, or a folder with an index', 'invalid_type');
    return { root: path.slice(0, path.lastIndexOf('/')) || '/', entry: name, folder: false };
  }, () => null);
  if (!target) throw new ArtifactError(404, 'File or folder not found', 'not_found');
  const type = typeOfEntry(target.entry)!;
  const text = await (await readVolumeFile(drive.platinumVolumeName, join(target.root, target.entry))).text();
  const [row] = await db.insert(artifacts).values({
    projectId: scope.projectId, accountId: scope.accountId, driveId: drive.driveId,
    root: target.root, entry: target.entry, folder: target.folder, type,
    title: input.title?.trim() || titleOf(type, text) || target.entry,
    description: input.description ?? null, visibility: input.visibility ?? 'private',
    createdByUserId: author.userId, createdBySessionId: author.sessionId,
  }).onConflictDoNothing().returning();
  if (!row) throw new ArtifactError(409, 'This path is already an artifact', 'already_shared');
  return row;
}

async function driveOf(row: ArtifactRow): Promise<DriveRow> {
  const drive = await getDrive(row.driveId);
  if (!drive) throw new ArtifactError(404, 'Files not found', 'not_found');
  return drive;
}

/** May the viewer change the artifact's files? Who may write its path in Files. */
export async function mayWrite(row: ArtifactRow, viewer: Viewer): Promise<boolean> {
  return accessAt(await driveOf(row), sharedPath(row), viewer, 'write');
}

/** The entry file's current version (its ETag): what `base_version` names. Null when the file is gone. */
export async function entryVersion(row: ArtifactRow): Promise<string | null> {
  const drive = await driveOf(row);
  return readDriveVolume(drive, async (volume) => (await statVolumeFile(volume, entryPath(row))).version, () => null)
    .catch((err) => {
      if (err instanceof DriveStorageError && err.status === 404) return null;
      throw err;
    });
}

/**
 * Write new content to the artifact's path in Files. A single-file artifact
 * takes only its entry; a folder takes any file inside it. `base_version`
 * (the entry's version the caller read) makes the entry write conditional:
 * someone else's save in between answers 409.
 */
export async function publishChanges(
  row: ArtifactRow,
  input: { title?: string; description?: string | null; files: Record<string, FileInput>; base_version?: string },
): Promise<ArtifactRow> {
  const drive = await driveOf(row);
  const files = encodeFiles(input.files).map((f) => ({ ...f, rel: row.folder ? f.rel : f.rel === 'index.md' || f.rel === 'index.html' ? row.entry : f.rel }));
  if (!row.folder && files.some((f) => f.rel !== row.entry)) throw new ArtifactError(400, `This artifact is one file: publish only ${row.entry}`, 'single_file');
  try {
    await writeDriveVolume(drive, async (volume) => {
      for (const f of files) {
        const isEntry = f.rel === row.entry;
        await writeVolumeFile(volume, join(row.root, f.rel), f.bytes, { overwrite: true, ...(isEntry && input.base_version ? { ifMatch: input.base_version } : {}) });
      }
    });
  } catch (err) {
    if (err instanceof DriveStorageError && err.code === 'file_changed') {
      throw new ArtifactError(409, 'Someone saved a newer version after the one you edited. Read it again and merge your change.', 'version_conflict');
    }
    throw err;
  }
  const entry = files.find((f) => f.rel === row.entry);
  const title = input.title?.trim() || (entry ? titleOf(row.type as ArtifactType, new TextDecoder().decode(entry.bytes)) : null);
  const [updated] = await db.update(artifacts).set({
    updatedAt: new Date(),
    ...(title ? { title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  }).where(eq(artifacts.artifactId, row.artifactId)).returning();
  return updated!;
}

export interface ArtifactVersion {
  /** The Files commit that made this version: what `at` reads and `restore` brings back. */
  id: string;
  /** 1 for the oldest version in the history window. */
  number: number;
  created_at: string;
}

/**
 * The artifact's history from the Files commit log, newest first: every commit
 * after which the entry file differs from before (each save). Reads the last
 * HISTORY_COMMITS commits of Files.
 * ponytail: one stat per commit (16 at a time); a per-path log from Platinum would make this one call.
 */
export async function listVersions(row: ArtifactRow): Promise<ArtifactVersion[]> {
  const drive = await driveOf(row);
  return readDriveVolume(drive, async (volume) => {
    const commits = (await listVolumeCommits(volume, HISTORY_COMMITS)).filter((c) => c.kind !== 'init').reverse();
    const versions: Array<string | null> = new Array(commits.length).fill(null);
    for (let i = 0; i < commits.length; i += 16) {
      await Promise.all(commits.slice(i, i + 16).map(async (c, j) => {
        try {
          versions[i + j] = (await statVolumeFile(volume, entryPath(row), c.id)).version ?? `${c.id}`;
        } catch (err) {
          if (!(err instanceof DriveStorageError && err.status === 404)) throw err;
        }
      }));
    }
    const changes: Array<(typeof commits)[number]> = [];
    let previous: string | null = null;
    commits.forEach((c, i) => {
      const v = versions[i];
      if (v && v !== previous) changes.push(c);
      if (v) previous = v;
    });
    return changes.map((c, i) => ({ id: c.id, number: i + 1, created_at: c.created_at })).reverse();
  }, () => []);
}

/** Bring an old version back: its entry file (and, for a folder, every file it had) written again, as a new save. */
export async function restoreVersion(row: ArtifactRow, commit: string): Promise<ArtifactRow> {
  const files: Record<string, FileInput> = {};
  for (const f of await listFiles(row, commit)) {
    const bytes = new Uint8Array(await (await readArtifactFile(row, f.path, commit)).arrayBuffer());
    files[f.path] = { content_base64: Buffer.from(bytes).toString('base64') };
  }
  if (!Object.keys(files).length) throw new ArtifactError(404, 'Version not found', 'version_not_found');
  return publishChanges(row, { files });
}

/** The artifact's files, now or at a commit: a folder's tree, or the single file. */
export async function listFiles(row: ArtifactRow, at?: string): Promise<Array<{ path: string; size: number; content_type: string }>> {
  const drive = await driveOf(row);
  return readDriveVolume(drive, async (volume) => {
    if (!row.folder) {
      const stat = await statVolumeFile(volume, entryPath(row), at);
      return [{ path: row.entry, size: stat.size, content_type: contentTypeFor(row.entry) }];
    }
    const prefix = row.root === '/' ? '/' : `${row.root}/`;
    return (await listVolumeFiles(volume, row.root, true, undefined, at))
      .filter((e) => e.type === 'file')
      .map((e) => ({ path: e.path.slice(prefix.length), size: e.size, content_type: contentTypeFor(e.path) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, () => []);
}

/** One file of the artifact, now or at a commit; `range` reads part of it (video seeking). A single-file artifact serves only its entry. */
export async function readArtifactFile(row: ArtifactRow, rel: string, at?: string | null, range?: string): Promise<Response> {
  if (!row.folder && rel !== row.entry) throw new DriveStorageError(404, 'File not found');
  const drive = await driveOf(row);
  return readVolumeFile(drive.platinumVolumeName, join(row.root, rel), range, at ?? undefined);
}

export async function getArtifact(projectId: string, artifactId: string): Promise<ArtifactRow | null> {
  const [row] = await db.select().from(artifacts)
    .where(and(eq(artifacts.projectId, projectId), eq(artifacts.artifactId, artifactId))).limit(1);
  return row ?? null;
}

/** For the content server: the artifact by id alone. */
export async function getArtifactById(artifactId: string): Promise<ArtifactRow | null> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.artifactId, artifactId)).limit(1);
  return row ?? null;
}

export type ListScope = 'all' | 'mine' | 'shared' | 'pinned';

/** The artifacts of a project that `userId` may view, newest change first. */
export async function listArtifacts(projectId: string, userId: string, opts: { scope: ListScope; type?: string; q?: string; limit: number }) {
  const visible = sql`(${artifacts.visibility} <> 'private' or ${artifacts.createdByUserId} = ${userId} or ${userId}::uuid = any(${artifacts.sharedWithUserIds}))`;
  const filters = [eq(artifacts.projectId, projectId), visible];
  if (opts.scope === 'mine') filters.push(eq(artifacts.createdByUserId, userId));
  if (opts.scope === 'shared') filters.push(sql`${artifacts.createdByUserId} <> ${userId}`);
  if (opts.scope === 'pinned') filters.push(sql`${userId}::uuid = any(${artifacts.pinnedByUserIds})`);
  if (opts.type) filters.push(eq(artifacts.type, opts.type));
  if (opts.q?.trim()) filters.push(sql`(${artifacts.title} ilike ${`%${opts.q.trim()}%`} or ${artifacts.description} ilike ${`%${opts.q.trim()}%`})`);
  return db.select().from(artifacts).where(and(...filters)).orderBy(desc(artifacts.updatedAt)).limit(opts.limit);
}

export function canView(row: ArtifactRow, userId: string): boolean {
  return row.visibility !== 'private' || row.createdByUserId === userId || row.sharedWithUserIds.includes(userId);
}

/** May change how the artifact is shared, rename it or remove it from Artifacts. */
export function canManage(row: ArtifactRow, viewer: Viewer): boolean {
  return row.createdByUserId === viewer.userId || (viewer.projectWrite && canView(row, viewer.userId));
}

export async function updateArtifactMeta(
  row: ArtifactRow,
  patch: { title?: string; description?: string | null; visibility?: ArtifactVisibility; shared_with_user_ids?: string[] },
): Promise<ArtifactRow> {
  const [updated] = await db.update(artifacts).set({
    ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.visibility ? { visibility: patch.visibility } : {}),
    ...(patch.shared_with_user_ids ? { sharedWithUserIds: [...new Set(patch.shared_with_user_ids)] } : {}),
    updatedAt: new Date(),
  }).where(eq(artifacts.artifactId, row.artifactId)).returning();
  return updated!;
}

export async function setPinned(row: ArtifactRow, userId: string, pinned: boolean): Promise<ArtifactRow> {
  const [updated] = await db.update(artifacts).set({
    pinnedByUserIds: pinned
      ? sql`array_append(array_remove(${artifacts.pinnedByUserIds}, ${userId}::uuid), ${userId}::uuid)`
      : sql`array_remove(${artifacts.pinnedByUserIds}, ${userId}::uuid)`,
  }).where(eq(artifacts.artifactId, row.artifactId)).returning();
  return updated!;
}

/** Stop sharing: the artifact leaves Artifacts and every link stops working. Its files stay in Files. */
export async function unshare(row: ArtifactRow): Promise<void> {
  await db.delete(artifacts).where(eq(artifacts.artifactId, row.artifactId));
}

export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPE_KEYS as readonly string[]).includes(value);
}
