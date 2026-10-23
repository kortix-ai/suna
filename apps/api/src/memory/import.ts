/**
 * The one-time import of a layer's Drive memory folder (job `memory-import`,
 * queued by `ensureLayerRow` when a layer is made with Drive on). Lazy: only
 * layers someone opens or a thread loads are ever made, so only those import.
 *
 * Folders: Company `/Company/Memory/`, a channel `/Company/Channels/<slug>/Memory/`,
 * a DM `<personal>/Memory/agents/<agent>/` (`spaceDriveFolders`). Each `*.md`
 * file at depth ≤ 2 except `MEMORY.md` becomes one page (`op: import`, author
 * `system`, one `change_id` per page so Undo removes one page). Drive files are
 * read only, never changed. A file holding a secret is skipped and logged by path.
 *
 * Idempotent: the pages and `imported_at` commit in one transaction that holds
 * the layer row lock and re-checks `imported_at`, so a second run imports nothing.
 * Drive off, no drive, no folder: `imported_at` is set with nothing imported.
 * A storage failure throws, and the job queue retries with backoff.
 */
import { randomUUID } from 'node:crypto';
import { MEMORY_LIMITS, type MemoryPageType } from '@kortix/api-contract';
import { memoryLayers, projectSpaces } from '@kortix/db';
import { spaceDriveFolders } from '@kortix/shared';
import { eq } from 'drizzle-orm';
import { conflictOriginal } from '../drives/access';
import { COMPANY_MEMORY_DIR } from '../drives/folders';
import { type DriveRow, findProjectDrive, listFolderGrants, personalFolderFor, readDriveVolume } from '../drives/service';
import { DriveStorageError, driveStorageAvailable, listVolumeFiles, readVolumeFile } from '../drives/volumes';
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

/**
 * The body to store: the text plus the source token, whole when it fits the
 * cap; else cut at the last line break within 8,000 bytes (or less, so the
 * note fits) and ended with a note that names the Drive path.
 */
export function cutBody(text: string, path: string): string {
  const whole = text ? `${text}\n\n${SOURCE_TOKEN}` : SOURCE_TOKEN;
  if (Buffer.byteLength(whole, 'utf8') <= MEMORY_LIMITS.body_bytes) return whole;
  const note = `\n\n(Imported in part; the full file is in Drive: ${path}) ${SOURCE_TOKEN}`;
  const budget = Math.max(0, Math.min(KEEP_BYTES, MEMORY_LIMITS.body_bytes - Buffer.byteLength(note, 'utf8')));
  const bytes = Buffer.from(text, 'utf8');
  let end = bytes.lastIndexOf(0x0a, budget);
  if (end <= 0) {
    // One long line: cut on a character boundary instead.
    end = budget;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  }
  return bytes.subarray(0, end).toString('utf8').trimEnd() + note;
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
 * The page of one Drive file. Title: the first `# ` heading (dropped from the
 * body when it is the first line), else the file name without extension.
 * Summary: the first line that is not blank and not a heading. Null for a
 * blank file and for one that holds a secret.
 */
export function importedPage(path: string, raw: string): ImportedPage | null {
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.trim() || findSecret(text)) return null;
  const fileName = baseName(path);
  const fallbackTitle = withoutExt(fileName).trim().slice(0, MEMORY_LIMITS.title_chars) || 'Imported';
  const lines = text.split('\n');
  const heading = lines.findIndex((line) => /^# \S/.test(line));
  const title = heading >= 0 ? lines[heading]!.slice(2).trim().slice(0, MEMORY_LIMITS.title_chars) : fallbackTitle;
  const firstLine = lines.findIndex((line) => line.trim() !== '');
  if (heading >= 0 && heading === firstLine) lines.splice(heading, 1);
  const summaryLine = lines.find((line) => line.trim() !== '' && !line.trimStart().startsWith('#')) ?? '';
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

/** The drive and Memory folder a layer imports from; null when there is none (Drive off, no drive, a DM owner without a folder). */
async function sourceFolder(layer: LayerToImport): Promise<{ drive: DriveRow; folder: string } | null> {
  if (!driveStorageAvailable() || !(await projectFeatureFlagEnabled(layer.projectId, 'drives'))) return null;
  const drive = await findProjectDrive(layer.projectId);
  if (!drive) return null;
  if (layer.scope === 'company') return { drive, folder: COMPANY_MEMORY_DIR };
  if (layer.scope === 'channel') {
    const folders = layer.slug ? spaceDriveFolders('channel', layer.slug, null) : null;
    return folders && { drive, folder: folders.memory };
  }
  if (!layer.dmUserId || !layer.dmAgentName) return null;
  const personal = personalFolderFor(await listFolderGrants(drive), layer.dmUserId);
  const folders = spaceDriveFolders('dm', layer.dmAgentName, personal);
  return folders && { drive, folder: folders.memory };
}

/** The pages of the folder's files. A missing folder or volume reads as no files. */
async function readFolder(drive: DriveRow, folder: string): Promise<Array<{ path: string; page: ImportedPage | null }>> {
  const entries = await readDriveVolume(
    drive,
    (volume) =>
      listVolumeFiles(volume, folder, true).catch((err) => {
        if (err instanceof DriveStorageError && err.status === 404) return [];
        throw err;
      }),
    () => [],
  );
  return mapWithConcurrency(importFiles(folder, entries), 4, async (entry) => {
    const res = await readVolumeFile(
      drive.platinumVolumeName,
      entry.path,
      Number(entry.size) > READ_BYTES ? `bytes=0-${READ_BYTES - 1}` : undefined,
    );
    const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, READ_BYTES);
    return { path: entry.path, page: importedPage(entry.path, new TextDecoder().decode(bytes)) };
  });
}

/** Write the pages and set `imported_at`, in one transaction under the layer lock. Returns how many pages were made. */
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
      const saved = await saveImported(tx, layer, page).catch((err: unknown) => {
        if (!(err instanceof MemoryError)) throw err;
        logger.warn('[memory] a Drive memory file was not imported', { layer_id: layer.layerId, path, code: err.code });
        return err.code === 'page_limit' ? 'full' : null;
      });
      if (saved === 'full') break;
      if (saved) made += 1;
    }
    if (made > 0) await bumpLayers(tx, [layer.layerId]);
    await tx.update(memoryLayers).set({ importedAt: new Date() }).where(eq(memoryLayers.layerId, layer.layerId));
    return made;
  });
}

/** One page under its title, else under its file name when the title is taken. Throws the MemoryError of the last try. */
async function saveImported(tx: Tx, layer: LayerToImport, page: ImportedPage): Promise<string> {
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
      return row.pageId;
    } catch (err) {
      if (!(err instanceof MemoryError && err.code === 'title_taken' && i < titles.length - 1)) throw err;
    }
  }
  throw new Error('unreachable: saveImported tried no title');
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
  const read = source ? await readFolder(source.drive, source.folder) : [];
  for (const { path, page } of read) {
    if (!page) logger.info('[memory] a blank Drive memory file, or one holding a secret, was not imported', { layer_id: layerId, path });
  }
  const files = read.filter((file): file is { path: string; page: ImportedPage } => file.page !== null);
  const made = await writeImport(layer, files);
  if (made !== null) logger.info('[memory] Drive memory imported', { layer_id: layerId, folder: source?.folder ?? null, pages: made });
}

registerJobHandler(MEMORY_IMPORT_QUEUE, (job) => importLayer(String(job.payload.layer_id ?? job.jobKey)));
