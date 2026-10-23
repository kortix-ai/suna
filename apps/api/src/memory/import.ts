/**
 * The one-time import of a layer's Drive memory folder (job `memory-import`,
 * queued by `ensureLayerRow` when a layer is made with Drive on). Lazy: only
 * layers someone opens or a thread loads are ever made, so only those import.
 *
 * Folders: Company `/Company/Memory/`, a channel `/Company/Channels/<slug>/Memory/`,
 * a DM `<personal>/Memory/agents/<agent>/` (`spaceDriveFolders`). Each `*.md`
 * file at depth ≤ 2 except `MEMORY.md` becomes one page (`op: import`, author
 * `system`, one `change_id` per page so Undo removes one page). Drive files are
 * read only, never changed.
 *
 * Skipped and logged by path (the rest still import): a file holding a secret,
 * a blank or unreadable file, a file whose write fails, and — for Company and
 * channels, which every member reads — a file the Drive grants do not let every
 * project member read.
 *
 * Idempotent: the pages and `imported_at` commit in one transaction that holds
 * the layer row lock and re-checks `imported_at`, so a second run imports nothing.
 * Drive off, no drive, no folder: `imported_at` is set with nothing imported.
 * A storage outage (503) throws, and the job queue retries with backoff.
 *
 * Decisions: an archived channel's layer still imports (the files predate the
 * archive; the pages are read-only like the rest of it). The import does not
 * re-check `project_channels`: a layer exists only with the flag on, and pages
 * of a flag-off project are kept data that nobody sees.
 */
import { randomUUID } from 'node:crypto';
import { MEMORY_LIMITS, type MemoryPageType } from '@kortix/api-contract';
import { memoryLayers, projectSpaces } from '@kortix/db';
import { spaceDriveFolders } from '@kortix/shared';
import { eq } from 'drizzle-orm';
import { conflictOriginal } from '../drives/access';
import { COMPANY_MEMORY_DIR, type FolderGrant, folderAccess } from '../drives/folders';
import { type DriveRow, findProjectDrive, listFolderGrants, personalFolderFor, readDriveVolume } from '../drives/service';
import { DriveStorageError, driveStorageAvailable, listVolumeFiles, readVolumeFile, type VolumeEntry } from '../drives/volumes';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { registerJobHandler } from '../shared/job-queue';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { MEMORY_IMPORT_QUEUE } from './layers';
import { findSecret } from './secret-check';
import { MemoryError } from './limits';
import { addSource, type Author, bumpLayers, savePage, type Tx } from './pages';

/** Files one layer imports at most. */
export const IMPORT_MAX_FILES = 200;
/** A file over the body cap keeps at most this many bytes, cut at a line break. */
const KEEP_BYTES = 8_000;
/** Bytes read per file: enough to fill a page and to see that it is cut. */
const READ_BYTES = 16 * 1024;
/** The source an imported page cites: its only source, so number 1. */
const SOURCE_TOKEN = '⟦1⟧';
const FENCE = /^\s*(```|~~~)/;

const SYSTEM_AUTHOR: Author = { kind: 'system', userId: null, agent: null, onBehalfUserId: null, sessionId: null, messageId: null };

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const withoutExt = (name: string) => name.replace(/\.md$/i, '');

/**
 * The files of a folder listing the import takes, in path order: `*.md` at
 * depth ≤ 2 under `folder`, not `MEMORY.md` (an index), not hidden, not a
 * conflict copy; at most 200.
 */
export function importFiles<T extends { path: string; type: string }>(folder: string, entries: readonly T[]): T[] {
  const prefix = `${folder}/`;
  return entries
    .filter((entry) => {
      if (entry.type !== 'file' || !entry.path.startsWith(prefix)) return false;
      const parts = entry.path.slice(prefix.length).split('/');
      const name = parts[parts.length - 1]!;
      return (
        parts.length <= 2 &&
        /\.md$/i.test(name) &&
        name.toLowerCase() !== 'memory.md' &&
        !parts.some((part) => part.startsWith('.')) &&
        !conflictOriginal(entry.path)
      );
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, IMPORT_MAX_FILES);
}

/** May every project member read `path` under these grants? Company and channel layers show a page to every member. */
export function everyMemberReads(path: string, grants: readonly FolderGrant[]): boolean {
  return folderAccess(path, grants, { projectMember: true }) !== 'none';
}

/** File bytes as text: UTF-16 by its byte order mark, else UTF-8; NUL characters (which Postgres text refuses) dropped. */
export function decodeFile(bytes: Uint8Array): string {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else text = new TextDecoder().decode(bytes);
  return text.replaceAll('\u0000', '');
}

const TYPE_BY_NAME: ReadonlyArray<[RegExp, MemoryPageType]> = [
  [/people|profile|contacts|customers/i, 'people'],
  [/decision/i, 'decisions'],
  [/work|project|launch|roadmap/i, 'workstreams'],
  [/playbook|convention|how-?to|process|style|preferences/i, 'playbooks'],
];

/** A page type from a file name keyword; `note` when none matches. */
export function pageTypeOf(fileName: string): MemoryPageType {
  return TYPE_BY_NAME.find(([re]) => re.test(fileName))?.[1] ?? 'note';
}

/** Per line: is it inside a fenced code block (fence lines included)? */
function fenced(lines: readonly string[]): boolean[] {
  let open = false;
  return lines.map((line) => {
    if (FENCE.test(line)) {
      open = !open;
      return true;
    }
    return open;
  });
}

/**
 * The body to store: the text plus the source token, whole when it fits the
 * cap; else cut at the last line break within 8,000 bytes (or less, so the
 * note fits), a code fence left open by the cut closed, and ended with a note
 * that names the Drive path.
 */
export function cutBody(text: string, path: string): string {
  const whole = text ? `${text}\n\n${SOURCE_TOKEN}` : SOURCE_TOKEN;
  if (Buffer.byteLength(whole, 'utf8') <= MEMORY_LIMITS.body_bytes) return whole;
  const close = '\n```';
  const note = `\n\n(Imported in part; the full file is in Drive: ${path}) ${SOURCE_TOKEN}`;
  const room = MEMORY_LIMITS.body_bytes - Buffer.byteLength(note + close, 'utf8');
  const budget = Math.max(0, Math.min(KEEP_BYTES, room));
  const bytes = Buffer.from(text, 'utf8');
  let end = bytes.lastIndexOf(0x0a, budget);
  if (end <= 0) {
    // One long line: cut on a character boundary instead.
    end = budget;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  }
  const kept = bytes.subarray(0, end).toString('utf8').trimEnd();
  const openFence = kept.split('\n').filter((line) => FENCE.test(line)).length % 2 === 1;
  return kept + (openFence ? close : '') + note;
}

export interface ImportedPage {
  type: MemoryPageType;
  title: string;
  /** The file name without its extension: the title when `title` is taken. */
  fallbackTitle: string;
  summary: string;
  body: string;
  /** The source label. */
  fileName: string;
}

/**
 * The page of one Drive file. Title: the first `# ` heading outside a code
 * fence (dropped from the body when it is the first line), else the file name
 * without extension. Summary: the first line that is not blank, not a heading
 * and not in a code fence. A blank file or one holding a secret is skipped.
 */
export function importedPage(path: string, raw: string): ImportedPage | { skip: 'blank' | 'secret' } {
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.trim()) return { skip: 'blank' };
  if (findSecret(text)) return { skip: 'secret' };
  const fileName = baseName(path);
  const fallbackTitle = withoutExt(fileName).trim().slice(0, MEMORY_LIMITS.title_chars) || 'Imported';
  const lines = text.split('\n');
  const inFence = fenced(lines);
  const heading = lines.findIndex((line, i) => !inFence[i] && /^# \S/.test(line));
  const title = heading >= 0 ? lines[heading]!.slice(2).trim().slice(0, MEMORY_LIMITS.title_chars) : fallbackTitle;
  const summaryLine =
    lines.find((line, i) => i !== heading && !inFence[i] && line.trim() !== '' && !/^\s*#{1,6}(\s|$)/.test(line)) ?? '';
  const firstLine = lines.findIndex((line) => line.trim() !== '');
  if (heading >= 0 && heading === firstLine) lines.splice(heading, 1);
  return {
    type: pageTypeOf(fileName),
    title,
    fallbackTitle,
    summary: summaryLine.replace(/\s+/g, ' ').trim().slice(0, MEMORY_LIMITS.summary_chars),
    body: cutBody(lines.join('\n').trim(), path),
    fileName,
  };
}

interface LayerToImport {
  layerId: string;
  projectId: string;
  scope: 'company' | 'channel' | 'dm';
  importedAt: Date | null;
  slug: string | null;
  dmUserId: string | null;
  dmAgentName: string | null;
}

interface Source {
  drive: DriveRow;
  folder: string;
  /** May the layer's readers read this file? */
  readable: (path: string) => boolean;
}

/** The drive and Memory folder a layer imports from; null when there is none (Drive off, no drive, a DM owner without a folder). */
async function sourceFolder(layer: LayerToImport): Promise<Source | null> {
  if (!driveStorageAvailable() || !(await projectFeatureFlagEnabled(layer.projectId, 'drives'))) return null;
  const drive = await findProjectDrive(layer.projectId);
  if (!drive) return null;
  const grants = await listFolderGrants(drive);
  const everyMember = (path: string) => everyMemberReads(path, grants);
  if (layer.scope === 'company') return { drive, folder: COMPANY_MEMORY_DIR, readable: everyMember };
  if (layer.scope === 'channel') {
    const folders = layer.slug ? spaceDriveFolders('channel', layer.slug, null) : null;
    return folders && { drive, folder: folders.memory, readable: everyMember };
  }
  // A DM's layer is its owner's only, and so is the folder: no grant check.
  if (!layer.dmUserId || !layer.dmAgentName) return null;
  const folders = spaceDriveFolders('dm', layer.dmAgentName, personalFolderFor(grants, layer.dmUserId));
  return folders && { drive, folder: folders.memory, readable: () => true };
}

type ReadFile = { path: string; page: ImportedPage } | { path: string; skip: string };

/** One file's page. A file storage refuses (gone, bad path, shrunk under the range) is skipped; an outage throws. */
async function readFile(drive: DriveRow, entry: VolumeEntry): Promise<ReadFile> {
  let res: Response;
  try {
    res = await readVolumeFile(drive.platinumVolumeName, entry.path, Number(entry.size) > READ_BYTES ? `bytes=0-${READ_BYTES - 1}` : undefined);
  } catch (err) {
    if (err instanceof DriveStorageError && err.status !== 503) return { path: entry.path, skip: 'unreadable' };
    throw err;
  }
  if (res.status === 416) return { path: entry.path, skip: 'blank' };
  const page = importedPage(entry.path, decodeFile(new Uint8Array(await res.arrayBuffer()).subarray(0, READ_BYTES)));
  return 'skip' in page ? { path: entry.path, skip: page.skip } : { path: entry.path, page };
}

/** The pages of the folder's files. A missing folder or volume reads as no files. */
async function readFolder({ drive, folder, readable }: Source): Promise<ReadFile[]> {
  const entries = await readDriveVolume(
    drive,
    (volume) =>
      listVolumeFiles(volume, folder, true).catch((err) => {
        if (err instanceof DriveStorageError && err.status === 404) return [];
        throw err;
      }),
    () => [],
  );
  return mapWithConcurrency(importFiles(folder, entries), 4, (entry) =>
    readable(entry.path) ? readFile(drive, entry) : Promise.resolve({ path: entry.path, skip: 'restricted' }),
  );
}

/** The error code a skip logs: never the message, which may quote file content. */
const errorCode = (err: unknown): string => {
  if (err instanceof MemoryError) return err.code;
  const { code, cause, name } = (err ?? {}) as { code?: unknown; cause?: { code?: unknown }; name?: unknown };
  return String(code ?? cause?.code ?? name ?? 'error');
};

/**
 * Write the pages and set `imported_at`, in one transaction under the layer
 * lock. Each file writes in its own savepoint, so a file that fails is logged
 * and skipped and the rest still import. Returns how many pages were made.
 */
async function writeImport(layer: LayerToImport, files: Array<{ path: string; page: ImportedPage }>): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ importedAt: memoryLayers.importedAt })
      .from(memoryLayers)
      .where(eq(memoryLayers.layerId, layer.layerId))
      .for('update');
    if (!locked || locked.importedAt) return null;
    let made = 0;
    for (const { path, page } of files) {
      try {
        await tx.transaction((savepoint) => saveImported(savepoint, layer, page));
        made += 1;
      } catch (err) {
        logger.warn('[memory] a Drive memory file was not imported', { layer_id: layer.layerId, path, reason: errorCode(err) });
        if (err instanceof MemoryError && err.code === 'page_limit') break;
      }
    }
    if (made > 0) await bumpLayers(tx, [layer.layerId]);
    await tx.update(memoryLayers).set({ importedAt: new Date() }).where(eq(memoryLayers.layerId, layer.layerId));
    return made;
  });
}

/** One page under its title, else under its file name when the title is taken. Throws the error of the last try. */
async function saveImported(tx: Tx, layer: LayerToImport, page: ImportedPage): Promise<void> {
  const titles = [...new Set([page.title, page.fallbackTitle])];
  for (const [i, title] of titles.entries()) {
    try {
      const { page: row } = await savePage(tx, {
        layerId: layer.layerId,
        projectId: layer.projectId,
        existing: null,
        next: { type: page.type, title, summary: page.summary, body: page.body, status: 'confirmed', related: [], deleted: false },
        op: 'import',
        changeId: randomUUID(),
        author: SYSTEM_AUTHOR,
      });
      await addSource(tx, row.pageId, { kind: 'import', label: page.fileName });
      return;
    } catch (err) {
      if (!(err instanceof MemoryError && err.code === 'title_taken' && i < titles.length - 1)) throw err;
    }
  }
}

/** Import the Drive memory of one layer, once. */
export async function importLayer(layerId: string): Promise<void> {
  const [layer] = await db
    .select({
      layerId: memoryLayers.layerId,
      projectId: memoryLayers.projectId,
      scope: memoryLayers.scope,
      importedAt: memoryLayers.importedAt,
      slug: projectSpaces.slug,
      dmUserId: projectSpaces.dmUserId,
      dmAgentName: projectSpaces.dmAgentName,
    })
    .from(memoryLayers)
    .leftJoin(projectSpaces, eq(projectSpaces.spaceId, memoryLayers.spaceId))
    .where(eq(memoryLayers.layerId, layerId))
    .limit(1);
  if (!layer || layer.importedAt) return;
  const source = await sourceFolder(layer);
  const read = source ? await readFolder(source) : [];
  const files: Array<{ path: string; page: ImportedPage }> = [];
  for (const file of read) {
    if ('page' in file) files.push(file);
    else logger.info('[memory] a Drive memory file was not imported', { layer_id: layerId, path: file.path, reason: file.skip });
  }
  const made = await writeImport(layer, files);
  if (made !== null) logger.info('[memory] Drive memory imported', { layer_id: layerId, folder: source?.folder ?? null, pages: made });
}

// 15 min: longer than one file read's own 5-min storage timeout, so a slow read never lets a second worker claim the job.
registerJobHandler(MEMORY_IMPORT_QUEUE, (job) => importLayer(String(job.payload.layer_id ?? job.jobKey)), 15 * 60_000);
