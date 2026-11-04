/**
 * The Yjs operations the server runs on a co-edited doc (KRTX-3670): check a
 * pushed update, and merge rows. The server NEVER integrates writer bytes (no
 * `Y.applyUpdate`, no `Y.Doc`), and never decodes an update it has not
 * scanned first (`doc-scan.ts`): a decode of crafted content can allocate
 * hundreds of megabytes. Scanning and merging are linear in the bytes.
 */
import { mergeUpdates } from 'yjs';
import { scanDocUpdate, type DocUpdateCheck } from './doc-scan';

export { DOC_MAX_DELETES, DOC_MAX_STRUCTS, DOC_MAX_TEXT_BYTES, type DocScanReason, type DocUpdateCheck } from './doc-scan';

/**
 * The check of a pushed update, a seed, and every row before compaction
 * merges it: the byte-level scan (`scanDocUpdate`), with no Yjs decode.
 * `push`: one tab's own changes (structs of one client at most); `seed`: a
 * whole doc, or stored rows (many clients).
 */
export function checkDocUpdate(update: Uint8Array, kind: 'push' | 'seed'): DocUpdateCheck {
  return scanDocUpdate(update, kind);
}

/** Updates merged per step: a k-way merge re-sorts its k inputs per struct run, so k stays small. */
const MERGE_FAN_IN = 4;

/**
 * Compaction: one update equal to applying `updates` (`Y.mergeUpdates`, no
 * integration), or null when the result would pass `maxBytes`: the caller
 * then keeps the rows. Merged as a tree of 4-way merges: one 500-way merge of
 * rows whose clocks interleave re-sorts 500 inputs per struct (593 ms for
 * 1.5 MB measured), the tree 4 per struct (101 ms for the same input).
 */
export function compactDocUpdates(updates: Uint8Array[], maxBytes: number): Uint8Array | null {
  let level = updates;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += MERGE_FAN_IN) {
      const merged = mergeUpdates(level.slice(i, i + MERGE_FAN_IN));
      if (merged.length > maxBytes) return null;
      next.push(merged);
    }
    level = next;
  }
  const result = level[0] ?? null;
  return result && result.length <= maxBytes ? result : null;
}

const EMPTY_UPDATE = new Uint8Array([0, 0]);

/**
 * A stored row some Yjs reader still takes: it passes the scan, and
 * `Y.mergeUpdates` reads it merged with an empty update (a merge of one
 * update returns it unread). Compaction quarantines a row that fails.
 */
export function mergesAlone(update: Uint8Array): boolean {
  if (!checkDocUpdate(update, 'seed').ok) return false;
  try {
    mergeUpdates([update, EMPTY_UPDATE]);
    return true;
  } catch {
    return false;
  }
}
