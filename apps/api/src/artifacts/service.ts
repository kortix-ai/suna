// Artifacts (flag `artifacts`): HTML pages a person or an agent publishes in a
// project. One Platinum volume per project holds the bytes as content-addressed
// blobs (`/<artifact_id>/<sha256>`); `artifact_versions` holds each version's
// manifest (path → blob). A blob never changes, so a new version writes only
// the files it adds or changes, and a restore is a manifest copy.
//
// Who may do what (the routes enforce the project leaves first):
//   view   the creator, anyone in shared_with_user_ids, every project member
//          when visibility is `project` or `public`, anyone with the link
//          when `public` (the content server)
//   edit   the creator, or a member with project.write who may view it
import { createHash } from 'node:crypto';
import { artifactVersions, artifacts, type ArtifactFileRecord } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { signChannelState } from '../channels/core/signed-state';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { openDriveVolume, readVolumeFile, removeVolumeFile, writeVolumeFile } from '../drives/volumes';
import { ARTIFACT_TYPE_KEYS, markdownDoc, type ArtifactType } from './formats';

export const ARTIFACTS_FLAG = 'artifacts' as const;
export const ARTIFACT_VISIBILITIES = ['private', 'project', 'public'] as const;
export type ArtifactVisibility = (typeof ARTIFACT_VISIBILITIES)[number];
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
export type { ArtifactType, ArtifactFileRecord };

export const ENTRY_PATH = 'index.html';
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_PUBLISH_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 255;

// Content URLs: served by artifacts/content-routes.ts.
const VIEW_TTL_MS = 12 * 60 * 60_000;

function apiBase(): string {
  return (config.KORTIX_URL ?? 'http://localhost:8008').replace(/\/+$/, '');
}

/** A signed URL that shows one version of the artifact for VIEW_TTL_MS. */
export function artifactViewUrl(artifactId: string, version: number): string {
  return `${apiBase()}/v1/artifacts/s/${signChannelState('artifact-view', { a: artifactId, v: version }, VIEW_TTL_MS)}/`;
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

/** The project's artifact volume: stable, unique, a valid volume name. */
export function artifactVolumeName(projectId: string): string {
  return `ka-${projectId.replace(/-/g, '').slice(0, 20)}`;
}

// replica-local: volumes this process already opened; a miss costs one idempotent PUT.
const openedVolumes = new Set<string>();
async function ensureVolume(projectId: string): Promise<string> {
  const name = artifactVolumeName(projectId);
  if (!openedVolumes.has(name)) {
    await openDriveVolume(name);
    openedVolumes.add(name);
  }
  return name;
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

/** A file path inside an artifact: relative, no `.`/`..`/empty segment. Null when it cannot be one. */
export function normalizeArtifactPath(raw: string): string | null {
  const value = raw.trim().replace(/^\/+/, '');
  if (!value || value.length > 512 || value.includes('\0') || value.includes('\\')) return null;
  const parts = value.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  return parts.join('/');
}

export interface FileInput {
  /** UTF-8 text. */
  content?: string;
  /** Bytes, base64. */
  content_base64?: string;
  content_type?: string;
}

export interface PublishInput {
  title?: string;
  description?: string | null;
  type?: ArtifactType;
  icon?: string | null;
  visibility?: ArtifactVisibility;
  label?: string | null;
  /** path → new content, or null to remove the path (updates only). */
  files: Record<string, FileInput | null>;
  /** The version the caller edited; a different current version answers 409. */
  base_version?: number;
  /**
   * Fold this save into the current version when the same person (and
   * session) made it less than AMEND_WINDOW_MS ago: the doc editor's autosave,
   * so one editing burst is one version.
   */
  amend?: boolean;
}

const AMEND_WINDOW_MS = 10 * 60_000;

/** A doc published as Markdown (`index.md`, no `index.html`) is stored as its HTML page. */
function docFiles(files: Record<string, FileInput | null>, type: string): Record<string, FileInput | null> {
  const md = files['index.md'];
  if (type !== 'doc' || !md || typeof md.content !== 'string' || files[ENTRY_PATH]) return files;
  const { 'index.md': _markdown, ...rest } = files;
  return { ...rest, [ENTRY_PATH]: { content: markdownDoc(md.content) } };
}

export interface Author {
  userId: string;
  sessionId: string | null;
}

function decodeFile(path: string, file: FileInput): Uint8Array<ArrayBuffer> {
  if (typeof file.content === 'string') return new Uint8Array(Buffer.from(file.content, 'utf8'));
  if (typeof file.content_base64 === 'string') return new Uint8Array(Buffer.from(file.content_base64, 'base64'));
  throw new ArtifactError(400, `File ${path} needs content or content_base64`, 'invalid_file');
}

/** Write the changed files as blobs and return the next manifest. */
async function writeFiles(
  projectId: string,
  artifactId: string,
  previous: Record<string, ArtifactFileRecord>,
  files: Record<string, FileInput | null>,
): Promise<Record<string, ArtifactFileRecord>> {
  const next: Record<string, ArtifactFileRecord> = { ...previous };
  const writes: Array<{ path: string; bytes: Uint8Array<ArrayBuffer>; record: ArtifactFileRecord }> = [];
  let total = 0;
  for (const [rawPath, file] of Object.entries(files)) {
    const path = normalizeArtifactPath(rawPath);
    if (!path) throw new ArtifactError(400, `Invalid file path: ${rawPath}`, 'invalid_path');
    if (file === null) {
      delete next[path];
      continue;
    }
    const bytes = decodeFile(path, file);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ArtifactError(413, `${path} is larger than 16 MB`, 'file_too_large');
    total += bytes.byteLength;
    const record: ArtifactFileRecord = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
      content_type: file.content_type?.trim() || contentTypeFor(path),
    };
    next[path] = record;
    if (!Object.values(previous).some((f) => f.sha256 === record.sha256)) writes.push({ path, bytes, record });
  }
  if (total > MAX_PUBLISH_BYTES) throw new ArtifactError(413, 'One publish carries at most 32 MB', 'publish_too_large');
  if (!next[ENTRY_PATH]) throw new ArtifactError(400, 'An artifact needs an index.html', 'missing_entry');
  if (Object.keys(next).length > MAX_FILES) throw new ArtifactError(400, `An artifact holds at most ${MAX_FILES} files`, 'too_many_files');
  if (writes.length) {
    const volume = await ensureVolume(projectId);
    const unique = new Map(writes.map((w) => [w.record.sha256, w]));
    await Promise.all([...unique.values()].map((w) =>
      writeVolumeFile(volume, `/${artifactId}/${w.record.sha256}`, w.bytes, { overwrite: true })));
  }
  return next;
}

/** The <title> of an HTML page, for an artifact published without a title. */
function htmlTitle(files: Record<string, FileInput | null>): string | null {
  const entry = files[ENTRY_PATH];
  if (!entry || typeof entry.content !== 'string') return null;
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(entry.content);
  return m?.[1]?.trim() || null;
}

export async function createArtifact(
  scope: { accountId: string; projectId: string },
  author: Author,
  input: PublishInput,
): Promise<{ artifact: ArtifactRow; version: ArtifactVersionRow }> {
  if (Object.values(input.files).some((f) => f === null)) throw new ArtifactError(400, 'A new artifact has no file to remove', 'invalid_file');
  const artifactId = crypto.randomUUID();
  const type = input.type ?? 'html';
  const files = docFiles(input.files, type);
  const manifest = await writeFiles(scope.projectId, artifactId, {}, files);
  const title = input.title?.trim() || htmlTitle(files) || 'Untitled';
  return db.transaction(async (tx) => {
    const [artifact] = await tx.insert(artifacts).values({
      artifactId,
      projectId: scope.projectId,
      accountId: scope.accountId,
      title,
      description: input.description ?? null,
      type,
      icon: input.icon ?? null,
      visibility: input.visibility ?? 'private',
      currentVersion: 1,
      createdByUserId: author.userId,
      createdBySessionId: author.sessionId,
    }).returning();
    const [version] = await tx.insert(artifactVersions).values({
      artifactId, version: 1, files: manifest, label: input.label ?? null,
      createdByUserId: author.userId, createdBySessionId: author.sessionId,
    }).returning();
    return { artifact: artifact!, version: version! };
  });
}

/** A new version: `files` adds or replaces paths, null removes one, every other path carries over. */
export async function publishVersion(
  current: ArtifactRow,
  author: Author,
  input: Omit<PublishInput, 'visibility'> & { files: Record<string, FileInput | null> },
  manifestOverride?: Record<string, ArtifactFileRecord>,
): Promise<{ artifact: ArtifactRow; version: ArtifactVersionRow }> {
  if (input.base_version !== undefined && input.base_version !== current.currentVersion) {
    throw new ArtifactError(409, `This artifact is at version ${current.currentVersion}; you edited version ${input.base_version}. Read it again and merge your change.`, 'version_conflict');
  }
  const prev = await getVersion(current.artifactId, current.currentVersion);
  const manifest = manifestOverride ?? await writeFiles(current.projectId, current.artifactId, prev?.files ?? {}, docFiles(input.files, input.type ?? current.type));
  const amend = input.amend && prev && prev.version > 1 && prev.createdByUserId === author.userId
    && prev.createdBySessionId === author.sessionId && Date.now() - prev.createdAt.getTime() < AMEND_WINDOW_MS;
  if (amend) {
    // ponytail: an amended version's replaced blobs stay on the volume until the artifact is deleted.
    return db.transaction(async (tx) => {
      const [artifact] = await tx.update(artifacts).set({
        updatedAt: new Date(),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      }).where(and(eq(artifacts.artifactId, current.artifactId), eq(artifacts.currentVersion, current.currentVersion))).returning();
      if (!artifact) throw new ArtifactError(409, 'Someone published a newer version at the same time. Read it again and merge your change.', 'version_conflict');
      const [version] = await tx.update(artifactVersions).set({ files: manifest })
        .where(and(eq(artifactVersions.artifactId, current.artifactId), eq(artifactVersions.version, current.currentVersion))).returning();
      return { artifact, version: version! };
    });
  }
  const nextVersion = current.currentVersion + 1;
  return db.transaction(async (tx) => {
    // The version guard makes two concurrent publishes from one version collide here.
    const [artifact] = await tx.update(artifacts).set({
      currentVersion: nextVersion,
      updatedAt: new Date(),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    }).where(and(eq(artifacts.artifactId, current.artifactId), eq(artifacts.currentVersion, current.currentVersion))).returning();
    if (!artifact) throw new ArtifactError(409, 'Someone published a newer version at the same time. Read it again and merge your change.', 'version_conflict');
    const [version] = await tx.insert(artifactVersions).values({
      artifactId: current.artifactId, version: nextVersion, files: manifest, label: input.label ?? null,
      createdByUserId: author.userId, createdBySessionId: author.sessionId,
    }).returning();
    return { artifact, version: version! };
  });
}

export async function restoreVersion(current: ArtifactRow, author: Author, version: number) {
  const old = await getVersion(current.artifactId, version);
  if (!old) throw new ArtifactError(404, `Version ${version} not found`, 'version_not_found');
  return publishVersion(current, author, { files: {}, label: `Restored version ${version}` }, old.files);
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

export async function getVersion(artifactId: string, version: number): Promise<ArtifactVersionRow | null> {
  const [row] = await db.select().from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version))).limit(1);
  return row ?? null;
}

export async function listVersions(artifactId: string): Promise<ArtifactVersionRow[]> {
  return db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, artifactId)).orderBy(desc(artifactVersions.version));
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

export function canEdit(row: ArtifactRow, userId: string, projectWrite: boolean): boolean {
  return row.createdByUserId === userId || (projectWrite && canView(row, userId));
}

export async function updateArtifactMeta(
  row: ArtifactRow,
  patch: { title?: string; description?: string | null; icon?: string | null; type?: ArtifactType; visibility?: ArtifactVisibility; shared_with_user_ids?: string[] },
): Promise<ArtifactRow> {
  const [updated] = await db.update(artifacts).set({
    ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
    ...(patch.type ? { type: patch.type } : {}),
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

export async function deleteArtifact(row: ArtifactRow): Promise<void> {
  await db.delete(artifacts).where(eq(artifacts.artifactId, row.artifactId));
  // The row is gone, so nothing serves the blobs; a failed sweep leaves only bytes.
  try {
    await removeVolumeFile(artifactVolumeName(row.projectId), `/${row.artifactId}`, true);
  } catch (err) {
    logger.warn('[artifacts] blob sweep failed', { artifactId: row.artifactId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** One file's bytes. */
export async function readArtifactFile(row: ArtifactRow, file: ArtifactFileRecord): Promise<Response> {
  return readVolumeFile(artifactVolumeName(row.projectId), `/${row.artifactId}/${file.sha256}`);
}

export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPE_KEYS as readonly string[]).includes(value);
}
