// The indexer: keeps `kortix.drive_index_entries` equal to each project
// drive's volume at its head, so one query searches a whole project's Files
// (drives/search-index/search.ts), not only the folders a session mounts.
//
// One pass (the `drive-index` job, every ~20 s on the scheduler leader):
// - picks at most DRIVES_PER_PASS drives not checked for RECHECK_MS, the ones
//   a running session mounts first, then the longest unchecked;
// - per drive, reads the volume head; nothing to do when the index holds it;
// - else lists the volume at that head, deletes rows for paths that are gone,
//   writes name rows for changed folders and non-text files, and reads at
//   most READS_PER_DRIVE text files (READ_BYTES_PER_DRIVE in all) for their
//   text. A file is written only once its text is read, so the next pass
//   picks up exactly the files still owed: a first pass over a large drive
//   resumes pass after pass, with no cursor to keep.
// - the head is recorded only when nothing is owed.
// A drive whose storage refuses (429, 503, anything) waits with backoff,
// alone: the other drives of the pass go on.

import { logger } from '../../lib/logger';
import { configuredTimeoutMs } from '../../shared/with-timeout';
import { activeDriveIds } from '../conflicts';
import { type DriveRow, driveVolume } from '../service';
import {
  DriveStorageError,
  type DriveVolume,
  type VolumeEntry,
  driveStorageAvailable,
  getDriveVolume,
  isMissingVolume,
  listVolumeFilesPage,
  readVolumeFile,
} from '../volumes';
import { baseName, extractText, indexReadBytes, isTextLike, mtimeDate } from './extract';
import {
  type IndexRow,
  type IndexedEntry,
  deleteIndexRows,
  dueDrives,
  indexedEntries,
  markIndexChecked,
  upsertIndexRows,
} from './store';

export const DRIVE_INDEX_PASS_MS = configuredTimeoutMs('KORTIX_DRIVE_INDEX_MS', 20_000, 2_000);
/** A drive's head is compared at most this often. */
const RECHECK_MS = configuredTimeoutMs('KORTIX_DRIVE_INDEX_RECHECK_MS', 60_000, 1_000);
const DRIVES_PER_PASS = 8;
const DRIVE_CONCURRENCY = 2;
/** The most entries one drive's index holds; past it the rest of the listing is left out, with a warning. */
export const MAX_INDEX_ENTRIES = 50_000;
const READS_PER_DRIVE = 200;
const READ_BYTES_PER_DRIVE = 32 * 1024 * 1024;
const READ_CONCURRENCY = 4;
/** The empty file that holds an otherwise empty folder in place (drives/routes.ts). */
const FOLDER_MARKER = '.keep';
const MAX_BACKOFF_MS = 30 * 60_000;

// replica-local: backoff per drive on the scheduler leader. A new leader
// forgets it and tries each drive once more before backing off again.
const backoff = new Map<string, { attempts: number; until: number }>();
export interface DriveIndexResult {
  /** `current`: the index already held the head; `indexed`: it holds it now; `partial`: files are still owed. */
  state: 'current' | 'indexed' | 'partial' | 'missing';
  upserted: number;
  deleted: number;
  read: number;
  owed: number;
}

/** The volume's entries at `head`, at most {@link MAX_INDEX_ENTRIES}, folder markers and symlinks left out. */
async function listAtHead(volume: DriveVolume, head: string | null): Promise<{ entries: VolumeEntry[]; truncated: boolean }> {
  const entries: VolumeEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await listVolumeFilesPage(volume, '/', {
      recursive: true,
      cursor,
      signal: AbortSignal.timeout(60_000),
      ...(head ? { at: head } : {}),
    });
    for (const e of page.entries) {
      if (e.type === 'symlink' || baseName(e.path) === FOLDER_MARKER || !e.path.startsWith('/')) continue;
      entries.push(e);
      if (entries.length >= MAX_INDEX_ENTRIES) return { entries, truncated: true };
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return { entries, truncated: false };
}

/** The first `cap` bytes of a file at `head`; the rest of the body is never read. */
async function readPrefix(volume: DriveVolume, path: string, cap: number, head: string | null): Promise<Uint8Array> {
  const res = await readVolumeFile(volume, path, `bytes=0-${cap - 1}`, head ?? undefined);
  if (res.status === 416 || !res.body) {
    await res.body?.cancel();
    return new Uint8Array(0);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, cap));
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.byteLength - at);
    out.set(chunk.subarray(0, take), at);
    at += take;
    if (at >= out.byteLength) break;
  }
  return out;
}

function sameEntry(have: IndexedEntry | undefined, e: VolumeEntry): boolean {
  if (!have) return false;
  const kind = e.type === 'dir' ? 'dir' : 'file';
  if (have.kind !== kind) return false;
  if (kind === 'dir') return true;
  const mtime = mtimeDate(e.mtime);
  return have.size === Number(e.size ?? 0) && (have.mtime?.getTime() ?? null) === (mtime?.getTime() ?? null);
}

function nameRow(e: VolumeEntry): IndexRow {
  return {
    path: e.path,
    kind: e.type === 'dir' ? 'dir' : 'file',
    size: e.type === 'dir' ? 0 : Number(e.size ?? 0),
    mtime: mtimeDate(e.mtime),
    name: baseName(e.path),
    body: '',
    contentHash: null,
  };
}

/** Bring one drive's index in line with its volume head, within this pass's budget. */
export async function indexDrive(drive: DriveRow): Promise<DriveIndexResult> {
  const result: DriveIndexResult = { state: 'current', upserted: 0, deleted: 0, read: 0, owed: 0 };
  if (!drive.platinumVolumeId) return result;
  const volume = driveVolume(drive);
  // A drive moving regions is fenced; the index waits for the move.
  if (volume.moving) return result;
  let head: string | null;
  try {
    head = (await getDriveVolume(volume, AbortSignal.timeout(10_000))).head_commit_id ?? null;
  } catch (err) {
    if (!isMissingVolume(err)) throw err;
    await markIndexChecked(drive.driveId);
    return { ...result, state: 'missing' };
  }
  if (head && head === drive.indexHead) {
    await markIndexChecked(drive.driveId);
    return result;
  }

  const { entries, truncated } = await listAtHead(volume, head);
  if (truncated) {
    logger.warn(`[drive-index] drive ${drive.driveId} holds more than ${MAX_INDEX_ENTRIES} entries; the rest stay out of search`);
  }
  const have = await indexedEntries(drive.driveId);
  const listed = new Set(entries.map((e) => e.path));
  const gone = [...have.keys()].filter((p) => !listed.has(p));
  await deleteIndexRows(drive.driveId, gone);
  result.deleted = gone.length;

  const names: IndexRow[] = [];
  const texts: VolumeEntry[] = [];
  for (const e of entries) {
    if (sameEntry(have.get(e.path), e)) continue;
    if (e.type === 'file' && isTextLike(e.path) && Number(e.size ?? 0) > 0) texts.push(e);
    else names.push(nameRow(e));
  }
  await upsertIndexRows(drive.driveId, names);
  result.upserted += names.length;

  // Text files, newest first, within the pass's budget.
  texts.sort((a, b) => Number(b.mtime ?? 0) - Number(a.mtime ?? 0));
  const batch: VolumeEntry[] = [];
  let bytes = 0;
  for (const e of texts) {
    const cost = Math.min(Number(e.size ?? 0), indexReadBytes(e.path));
    if (batch.length >= READS_PER_DRIVE || (batch.length > 0 && bytes + cost > READ_BYTES_PER_DRIVE)) break;
    batch.push(e);
    bytes += cost;
  }
  result.owed = texts.length - batch.length;
  const rows: IndexRow[] = [];
  let next = 0;
  const reader = async () => {
    while (next < batch.length) {
      const e = batch[next++]!;
      try {
        const extracted = extractText(e.path, await readPrefix(volume, e.path, indexReadBytes(e.path), head));
        rows.push({ ...nameRow(e), body: extracted.body, contentHash: extracted.contentHash });
      } catch (err) {
        // Gone since the listing: the next pass deletes its row.
        if (err instanceof DriveStorageError && err.status === 404) continue;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, batch.length) }, reader));
  await upsertIndexRows(drive.driveId, rows);
  result.upserted += rows.length;
  result.read = rows.length;

  if (result.owed > 0) {
    await markIndexChecked(drive.driveId);
    return { ...result, state: 'partial' };
  }
  await markIndexChecked(drive.driveId, head);
  return { ...result, state: 'indexed' };
}

function backoffFor(driveId: string, err: unknown): number {
  const prev = backoff.get(driveId)?.attempts ?? 0;
  const retryAfter = err instanceof DriveStorageError && err.retryAfterSeconds ? err.retryAfterSeconds * 1_000 : 0;
  const wait = Math.min(MAX_BACKOFF_MS, Math.max(retryAfter, 30_000 * 2 ** Math.min(prev, 10)));
  backoff.set(driveId, { attempts: prev + 1, until: Date.now() + wait });
  return wait;
}

let indexing = false;

/** One indexer pass (the `drive-index` job's tick). */
export async function runDriveIndexPass(): Promise<{ drives: number; failed: number }> {
  if (indexing || !driveStorageAvailable()) return { drives: 0, failed: 0 };
  indexing = true;
  let failed = 0;
  try {
    const now = Date.now();
    const waiting = new Set([...backoff].filter(([, b]) => b.until > now).map(([id]) => id));
    const active = await activeDriveIds().catch(() => [] as string[]);
    const due = (await dueDrives(DRIVES_PER_PASS + waiting.size, RECHECK_MS, active))
      .filter((d) => !waiting.has(d.driveId))
      .slice(0, DRIVES_PER_PASS);
    let i = 0;
    const worker = async () => {
      while (i < due.length) {
        const drive = due[i++]!;
        try {
          const r = await indexDrive(drive);
          backoff.delete(drive.driveId);
          if (r.state === 'indexed' || r.state === 'partial') {
            logger.info(
              `[drive-index] drive ${drive.driveId}: ${r.state}, ${r.upserted} written (${r.read} read), ${r.deleted} removed, ${r.owed} owed`,
            );
          }
        } catch (err) {
          failed++;
          const wait = backoffFor(drive.driveId, err);
          await markIndexChecked(drive.driveId).catch(() => {});
          logger.warn(`[drive-index] drive ${drive.driveId} failed; next try in ${Math.round(wait / 1000)} s:`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DRIVE_CONCURRENCY, due.length) }, worker));
    return { drives: due.length, failed };
  } finally {
    indexing = false;
  }
}
