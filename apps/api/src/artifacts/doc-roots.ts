/**
 * The root rule for items placed by an origin (KRTX-3670). The root fragment
 * `default` may hold XML elements only: y-tiptap throws on any other child, so
 * every tab that loads the doc fails to mount. An item with an origin or a
 * right origin carries no parent in its bytes: Yjs gives it the parent of that
 * origin item at integration (`Item.getMissing`). So an item is root-level
 * when its parent is `default`, or when its origin or right origin is a
 * root-level item; a root-level item must be an XML element
 * (`root_not_element`).
 *
 * The service keeps two indexes per live doc, in the transaction that stores
 * each update: every root-level item ID (`artifact_doc_roots`; an element has
 * length 1, so an ID is one clock) and, per client, the clock after its last
 * stored struct (`artifact_doc_clients`). Three rules keep the index exact,
 * equal to what Yjs places at the root:
 *   - every origin and right origin outside the update is a stored ID
 *     (`unknown_origin`): Yjs holds an item whose origin it lacks and places
 *     it later, under a parent no check saw;
 *   - a client's structs are contiguous: an update starts at or before the
 *     clock after that client's stored structs, with no Skip (`clock_gap`);
 *   - stored clocks are placed once: a client that sends them again (a retry
 *     whose answer was lost) places each one exactly as stored, and no struct
 *     runs from stored clocks into new ones (`clock_overlap`). Yjs keeps the
 *     first version of a clock, and `Y.mergeUpdates` may keep either.
 *
 * Pure functions: the service reads the index (`rootLookups` names what to
 * read, at most two IDs per struct) and writes back what `decideRoots`
 * returns. No Yjs decode, no integration.
 */
import { DOC_PLACEMENT_FIELDS, DOC_STRUCT, type DocPlacement } from './doc-scan';

export type DocRootReason = 'root_not_element' | 'unknown_origin' | 'clock_gap' | 'clock_overlap';

export type DocRootDecision =
  | { ok: true; roots: number[]; nextClock: number }
  | { ok: false; reason: DocRootReason };

/** What the service read from the index for one update. */
export interface DocStoredRoots {
  /** The clock after the stored structs of the update's client (0 for a new client). */
  nextClock: number;
  /** Whether an ID outside the update is stored (its client's stored structs pass that clock). */
  known: (client: number, clock: number) => boolean;
  /** Whether an ID outside the update is a root-level item. */
  root: (client: number, clock: number) => boolean;
  /** The stored root-level clocks of the update's client in `rootLookups(...).overlap`, at most its `limit`. */
  storedRoots: ReadonlySet<number>;
}

const isRef = (client: number) => client >= 0;

/**
 * What to read for `update`: the distinct origin and right-origin IDs outside
 * it (another client's, or its own client's stored clocks), and the range of
 * stored clocks it sends again. `limit`: the structs in that range, plus one:
 * more stored roots than that is already a mismatch.
 */
export function rootLookups(
  p: DocPlacement,
  nextClock: number,
): { refs: Array<[client: number, clock: number]>; overlap: { from: number; to: number; limit: number } | null } {
  if (p.client === null || p.gap || p.start > nextClock) return { refs: [], overlap: null };
  const refs = new Map<string, [number, number]>();
  const s = p.structs;
  let overlapStructs = 0;
  for (let i = 0; i < s.length; i += DOC_PLACEMENT_FIELDS) {
    if (s[i]! < nextClock) overlapStructs += 1;
    for (const at of [i + 3, i + 5]) {
      const client = s[at]!;
      const clock = s[at + 1]!;
      if (!isRef(client) || (client === p.client && clock >= nextClock)) continue;
      refs.set(`${client}:${clock}`, [client, clock]);
    }
  }
  const to = Math.min(nextClock, p.end);
  return { refs: [...refs.values()], overlap: p.start < to ? { from: p.start, to, limit: overlapStructs + 1 } : null };
}

/**
 * The root rule for one update, given what the index holds. Accepted: the
 * root-level clocks this update adds (its client's, at or past `nextClock`),
 * and the clock after its client's structs once stored.
 */
export function decideRoots(p: DocPlacement, stored: DocStoredRoots): DocRootDecision {
  if (p.client === null) return { ok: true, roots: [], nextClock: stored.nextClock };
  if (p.gap || p.start > stored.nextClock) return { ok: false, reason: 'clock_gap' };
  const own = p.client;
  const next = stored.nextClock;
  const fresh = new Set<number>();
  const roots: number[] = [];
  // An ID of the update's own new clocks is decided here; any other ID is stored.
  const rootAt = (client: number, clock: number) => (client === own && clock >= next ? fresh.has(clock) : stored.root(client, clock));
  const knownAt = (client: number, clock: number) => (client === own && clock >= next) || stored.known(client, clock);
  let resentRoots = 0;
  const s = p.structs;
  for (let i = 0; i < s.length; i += DOC_PLACEMENT_FIELDS) {
    const clock = s[i]!;
    const length = s[i + 1]!;
    const kind = s[i + 2]!;
    const originClient = s[i + 3]!;
    const originClock = s[i + 4]!;
    const rightClient = s[i + 5]!;
    const rightClock = s[i + 6]!;
    if (clock < next && clock + length > next) return { ok: false, reason: 'clock_overlap' };
    if (isRef(originClient) && !knownAt(originClient, originClock)) return { ok: false, reason: 'unknown_origin' };
    if (isRef(rightClient) && !knownAt(rightClient, rightClock)) return { ok: false, reason: 'unknown_origin' };
    const placed = kind === DOC_STRUCT.placed || kind === DOC_STRUCT.placedElement;
    const atRoot =
      kind === DOC_STRUCT.root ||
      (placed && ((isRef(originClient) && rootAt(originClient, originClock)) || (isRef(rightClient) && rootAt(rightClient, rightClock))));
    if (atRoot && kind !== DOC_STRUCT.root && kind !== DOC_STRUCT.placedElement) return { ok: false, reason: 'root_not_element' };
    if (clock < next) {
      // Sent again: it must sit where the stored version sits.
      if (atRoot !== stored.storedRoots.has(clock)) return { ok: false, reason: 'clock_overlap' };
      if (atRoot) resentRoots += 1;
    } else if (atRoot) {
      fresh.add(clock);
      roots.push(clock);
    }
  }
  // A stored root clock inside a struct this update sends as something else (not counted above).
  if (stored.storedRoots.size !== resentRoots) return { ok: false, reason: 'clock_overlap' };
  return { ok: true, roots, nextClock: Math.max(next, p.end) };
}
