/**
 * Keyset pagination for `GET /v1/projects/:projectId/sessions?limit=&cursor=`.
 *
 * The unpaged route reads every session row for the project and folds
 * visibility in JS. On a project with thousands of sessions that is a response
 * linear in the session count, and every client renders all of it. The paged
 * form returns one page and an opaque `next_cursor`.
 *
 * ─── Order ──────────────────────────────────────────────────────────────────
 * Last activity DESC, then `session_id DESC` — the same instant the clients
 * sort and section by (`sessionLastActivityAt`): the newer of
 * `metadata.last_activity_at` and the OpenCode snapshot's newest `updated_at`,
 * else `updated_at`. Pages therefore arrive in display order, so an
 * infinite list only ever grows at its foot.
 *
 * `updated_at` alone is NOT that order. Bookkeeping writers advance it with no
 * activity — branch GC stamps `metadata.branch_gc` on every old stopped
 * session — so a keyset on it put year-old sessions on page 1.
 *
 * ─── Why a loop, not one LIMIT ──────────────────────────────────────────────
 * Visibility is decided per row in JS (`selectSessionRowsForViewer`: grants,
 * warm marker, soft delete, runtime status). A SQL `LIMIT n` therefore returns
 * pages SHORTER than n for any viewer the fold drops rows for. The collector
 * reads batches of `limit + 1`, folds each, and stops once it holds `limit + 1`
 * visible rows (the extra row proves a next page exists without a COUNT).
 *
 * The scan budget bounds one request for a viewer who can open almost nothing:
 * the page returns what it found (possibly nothing) with a cursor at the last
 * SCANNED row, and the client's next request resumes there.
 *
 * ─── Why the cursor is text from SQL ────────────────────────────────────────
 * The activity instant is `timestamptz` with microseconds. Drizzle maps it to a JS
 * `Date`, which keeps milliseconds. A cursor built from the `Date` is
 * truncated below its own row, so `(updated_at, session_id) < cursor` skips
 * every later row that shares that millisecond: a silent gap in the list.
 * The reader selects the exact instant as text instead (see `session-list.ts`).
 */

export interface SessionCursor {
  /** The row's last-activity instant, ISO-8601 with microsecond precision.
   *  (Named for the wire format it has always had; it is the activity key.) */
  updatedAt: string;
  sessionId: string;
}

export const SESSION_PAGE_DEFAULT_LIMIT = 50;
export const SESSION_PAGE_MAX_LIMIT = 200;
/** Rows one request may fold before it returns a partial page. */
export const SESSION_PAGE_SCAN_BUDGET = 1_000;

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export function encodeSessionCursor(cursor: SessionCursor): string {
  return `${cursor.updatedAt}|${cursor.sessionId}`;
}

export function parseSessionCursor(value: string): SessionCursor {
  const separator = value.indexOf('|');
  if (separator <= 0 || separator !== value.lastIndexOf('|')) throw new Error('cursor is invalid');
  const updatedAt = value.slice(0, separator);
  const sessionId = value.slice(separator + 1);
  if (!sessionId || !ISO_INSTANT_RE.test(updatedAt)) throw new Error('cursor is invalid');
  // The regex accepts month 13; the date parser does not.
  if (Number.isNaN(new Date(updatedAt).getTime())) throw new Error('cursor is invalid');
  return { updatedAt, sessionId };
}

export function parseSessionPageLimit(value: string | undefined): number {
  if (value === undefined) return SESSION_PAGE_DEFAULT_LIMIT;
  const message = `limit must be an integer from 1 to ${SESSION_PAGE_MAX_LIMIT}`;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(message);
  const parsed = Number(value);
  if (parsed > SESSION_PAGE_MAX_LIMIT) throw new Error(message);
  return parsed;
}

export async function collectSessionPage<Row, Item>(input: {
  limit: number;
  after: SessionCursor | null;
  /** Rows strictly after `after` in page order, at most `size` of them. */
  readBatch: (
    after: SessionCursor | null,
    size: number,
  ) => Promise<Array<{ row: Row; cursor: SessionCursor }>>;
  /** The visibility fold. Must keep batch order. */
  selectVisible: (rows: Row[]) => Promise<Item[]>;
  /** The row a fold item came from. Identity when the fold returns rows. */
  rowOf?: (item: Item) => Row;
  scanBudget?: number;
}): Promise<{ items: Item[]; nextCursor: SessionCursor | null }> {
  const rowOf = input.rowOf ?? ((item: Item) => item as unknown as Row);
  const batchSize = input.limit + 1;
  const scanBudget = input.scanBudget ?? SESSION_PAGE_SCAN_BUDGET;
  const items: Array<{ item: Item; cursor: SessionCursor }> = [];
  let after = input.after;
  let scanned = 0;

  for (;;) {
    const batch = await input.readBatch(after, batchSize);
    scanned += batch.length;
    const cursorByRow = new Map(batch.map((entry) => [entry.row, entry.cursor]));
    const visible = await input.selectVisible(batch.map((entry) => entry.row));
    for (const item of visible) {
      const cursor = cursorByRow.get(rowOf(item));
      if (cursor) items.push({ item, cursor });
    }

    if (items.length > input.limit) {
      return {
        items: items.slice(0, input.limit).map((entry) => entry.item),
        nextCursor: items[input.limit - 1]!.cursor,
      };
    }
    if (batch.length < batchSize) {
      return { items: items.map((entry) => entry.item), nextCursor: null };
    }
    after = batch[batch.length - 1]!.cursor;
    if (scanned >= scanBudget) {
      return { items: items.map((entry) => entry.item), nextCursor: after };
    }
  }
}
