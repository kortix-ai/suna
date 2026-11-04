/**
 * The Yjs operations the server runs on a co-edited doc (KRTX-3670): check a
 * pushed update, and merge rows. Contract v2: the server NEVER integrates
 * writer bytes (no `Y.applyUpdate`, no `Y.Doc`). Integration of a crafted
 * update can take minutes and would freeze a web replica; decoding and
 * merging are linear in the bytes.
 */
import { Item, decodeUpdate, mergeUpdates } from 'yjs';

/** Structs one update may carry. */
export const DOC_MAX_STRUCTS = 200_000;

export type DocUpdateCheck = { ok: true } | { ok: false; reason: 'malformed' | 'too_many_structs' | 'many_clients' | 'self_reference' };

type Id = { client: number; clock: number };
const isId = (value: unknown): value is Id =>
  typeof value === 'object' && value !== null && typeof (value as Id).client === 'number' && typeof (value as Id).clock === 'number';

/**
 * Structural checks, without integration:
 *   - `Y.decodeUpdate` reads it;
 *   - at most `DOC_MAX_STRUCTS` structs;
 *   - a push carries the structs of ONE client at most (a tab pushes only its
 *     own changes; a delete-only update carries none); a seed may carry many;
 *   - an item whose origin, right origin or parent names its own client names
 *     a LOWER clock: such an item points at its own future, and every client
 *     that applies it throws, on every load, for ever (the 17-byte poison).
 */
export function checkDocUpdate(update: Uint8Array, kind: 'push' | 'seed'): DocUpdateCheck {
  let structs: ReturnType<typeof decodeUpdate>['structs'];
  try {
    structs = decodeUpdate(update).structs;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (structs.length > DOC_MAX_STRUCTS) return { ok: false, reason: 'too_many_structs' };
  let client: number | null = null;
  for (const struct of structs) {
    const own = struct.id.client;
    if (kind === 'push' && client !== null && own !== client) return { ok: false, reason: 'many_clients' };
    client = own;
    if (!(struct instanceof Item)) continue;
    for (const ref of [struct.origin, struct.rightOrigin, struct.parent]) {
      if (isId(ref) && ref.client === own && ref.clock >= struct.id.clock) return { ok: false, reason: 'self_reference' };
    }
  }
  return { ok: true };
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
