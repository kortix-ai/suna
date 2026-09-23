import { sessionLifecycleCommands } from '@kortix/db';
import { asc, sql } from 'drizzle-orm';

interface InboxOrderRow {
  commandId: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * The durable inbox's one FIFO key.
 *
 * The lane comes first. Quick Queue ends the active response at its next tool
 * boundary, so it runs before every Queue List entry, whatever their send
 * order. Only an explicit `placement: 'composer'` joins the later lane: a first
 * prompt, an automation row, or an older producer has no placement and keeps
 * its send-order place ahead of Queue List.
 *
 * `created_at` is the order in which concurrent HTTP requests reached
 * PostgreSQL. `clientSentAtMs` is the order in which the user pressed Enter.
 * The API accepts that value only inside a ten-minute server-clock window, so
 * it is safe to use as the primary key. Older producers have no value and fall
 * back to `created_at`.
 *
 * The original wire id and `command_id` make equal-millisecond sends a total
 * order. The SDK mints wire ids monotonically for one session, so two Enter
 * events in one millisecond retain their client order. Every queue reader,
 * admission predicate, batch, and promotion must use this exact tuple. Mixing
 * this tuple with `created_at` caused a prompt to render in one order, execute
 * in another, and reverse after transcript hydration.
 */
export const inboxLaneSql = sql<number>`CASE
  WHEN ${sessionLifecycleCommands.payload}->>'placement' = 'composer' THEN 1
  ELSE 0
END`;

export function inboxLane(row: Pick<InboxOrderRow, 'payload'>): 0 | 1 {
  return (row.payload as { placement?: unknown } | null)?.placement === 'composer' ? 1 : 0;
}

export const inboxSentAtSql = sql<bigint>`CASE
  WHEN ${sessionLifecycleCommands.payload}->>'clientSentAtMs' ~ '^[0-9]{1,16}$'
    THEN (${sessionLifecycleCommands.payload}->>'clientSentAtMs')::bigint
  ELSE floor(extract(epoch FROM ${sessionLifecycleCommands.createdAt}) * 1000)::bigint
END`;

export const inboxWireIdSql = sql<string>`COALESCE(
  ${sessionLifecycleCommands.payload}->>'wireMessageId',
  ''
) COLLATE "C"`;

export function inboxSendOrderMs(row: Pick<InboxOrderRow, 'payload' | 'createdAt'>): number {
  const value = (row.payload as { clientSentAtMs?: unknown } | null)?.clientSentAtMs;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : row.createdAt.getTime();
}

export function compareInboxSendOrder(left: InboxOrderRow, right: InboxOrderRow): number {
  const lane = inboxLane(left) - inboxLane(right);
  if (lane !== 0) return lane;
  const sent = inboxSendOrderMs(left) - inboxSendOrderMs(right);
  if (sent !== 0) return sent;
  const leftWire = (left.payload as { wireMessageId?: unknown } | null)?.wireMessageId;
  const rightWire = (right.payload as { wireMessageId?: unknown } | null)?.wireMessageId;
  const leftWireId = typeof leftWire === 'string' ? leftWire : '';
  const rightWireId = typeof rightWire === 'string' ? rightWire : '';
  // Wire ids and UUIDs are ASCII. Use bytewise comparisons here and the C
  // collation in SQL so JavaScript and PostgreSQL define the same total order.
  const wire = leftWireId < rightWireId ? -1 : leftWireId > rightWireId ? 1 : 0;
  if (wire !== 0) return wire;
  return left.commandId < right.commandId ? -1 : left.commandId > right.commandId ? 1 : 0;
}

export function inboxOrderBy() {
  return [
    asc(inboxLaneSql),
    asc(inboxSentAtSql),
    asc(inboxWireIdSql),
    asc(sessionLifecycleCommands.commandId),
  ] as const;
}

/** Rows that precede `row` in the exact tuple used by {@link inboxOrderBy}. */
export function inboxPrecedesRow(row: InboxOrderRow) {
  const wireMessageId = (row.payload as { wireMessageId?: unknown } | null)?.wireMessageId;
  return sql`(${inboxLaneSql}, ${inboxSentAtSql}, ${inboxWireIdSql}, ${sessionLifecycleCommands.commandId})
    < (${inboxLane(row)}::int, ${inboxSendOrderMs(row)}::bigint, ${typeof wireMessageId === 'string' ? wireMessageId : ''}::text COLLATE "C", ${row.commandId}::uuid)`;
}

/** Rows that follow `row` in the exact tuple used by {@link inboxOrderBy}. */
export function inboxFollowsRow(row: InboxOrderRow) {
  const wireMessageId = (row.payload as { wireMessageId?: unknown } | null)?.wireMessageId;
  return sql`(${inboxLaneSql}, ${inboxSentAtSql}, ${inboxWireIdSql}, ${sessionLifecycleCommands.commandId})
    > (${inboxLane(row)}::int, ${inboxSendOrderMs(row)}::bigint, ${typeof wireMessageId === 'string' ? wireMessageId : ''}::text COLLATE "C", ${row.commandId}::uuid)`;
}

/**
 * Was `later` SENT after `earlier` — by the user's Enter, not by the drain's
 * lane — with the server's own clock agreeing?
 *
 * The send instant and the two tiebreaks of {@link compareInboxSendOrder},
 * WITHOUT the lane. The lane is drain order: Quick Queue runs ahead of an
 * older Queue List entry, and that is right for who runs first. It is wrong
 * for where a message SITS: a composer prompt the user typed first was still
 * typed first, whichever lane later overtook it.
 *
 * AND `created_at`. The send instant is `clientSentAtMs` when the producer
 * stamped one: the SENDER's clock, accepted inside a ten-minute server
 * window, and two clients of one session need not agree on it. A tab whose
 * clock runs 30 s ahead stamps its ALPHA "after" a second tab's BRAVO sent
 * 2 s later; ALPHA is lifted, and BRAVO's gate would read ALPHA as sent
 * after it and keep BRAVO's client id UNDER the lifted id — the measured
 * inversion, from clock skew (review finding, 2026-09-22). So a sibling is
 * "sent after" only when the Enter stamps AND the rows' `created_at` — one
 * clock, PostgreSQL's, for every producer — both say so. Equal `created_at`
 * (two inserts in one millisecond) leaves the Enter stamps to decide. When
 * the clocks disagree the answer is `false`, and the caller re-mints: the
 * monotonic side. The cost is one shape: an Enter whose POST reached the
 * server AFTER a later Enter's (a slow network) re-mints above it instead of
 * keeping its client id below — the two render in arrival order, ids still
 * ascending, nothing stranded.
 */
export function inboxSentAfter(
  later: Pick<InboxOrderRow, 'commandId' | 'payload' | 'createdAt'>,
  earlier: Pick<InboxOrderRow, 'commandId' | 'payload' | 'createdAt'>,
): boolean {
  const reached = later.createdAt.getTime() - earlier.createdAt.getTime();
  if (reached < 0) return false;
  const sent = inboxSendOrderMs(later) - inboxSendOrderMs(earlier);
  if (sent !== 0) return sent > 0;
  const laterWire = (later.payload as { wireMessageId?: unknown } | null)?.wireMessageId;
  const earlierWire = (earlier.payload as { wireMessageId?: unknown } | null)?.wireMessageId;
  const laterWireId = typeof laterWire === 'string' ? laterWire : '';
  const earlierWireId = typeof earlierWire === 'string' ? earlierWire : '';
  if (laterWireId !== earlierWireId) return laterWireId > earlierWireId;
  return later.commandId > earlier.commandId;
}

/**
 * May a first delivery keep its client wire id BELOW the open user messages
 * above it, so its original id slots it into its SEND position?
 *
 * Only when every open sibling above was SENT AFTER this row. Then the client
 * id IS the send position, and the later sibling's step answers both
 * (OpenCode hands the model the whole transcript).
 *
 * A sibling above that was sent EARLIER carries a LIFTED id: `mintLivePlacement`
 * places a live-turn delivery at the box clock, far above every client id.
 * Under-placing this row beneath it puts a later send below an earlier one,
 * and the SDK orders placed messages by id — the tab draws them swapped, and
 * the merged reply (parented on the newest user by `time.created`) leaves the
 * earlier prompt's slot empty at the bottom. Measured 2026-09-22 (preview
 * session "YO" 134c0d27 on project 0544daaf; locally 6e288d75 and 822e92a4):
 * ALPHA sent 12:15:07 lifted to …a831b000, BRAVO sent 12:15:10 kept
 * …a5f79003, rendered BRAVO above ALPHA. The re-mint is already monotonic
 * over delivered ids (`readDeliveredWireIdFloor`), so refusing here lands
 * this row above the lifted sibling, in send order.
 *
 * A sibling with NO inbox row (`row: null`) is a foreign producer's message
 * — an automation prompt, a CLI send — and its send instant is unknown. It
 * keeps today's behaviour: under-place, as `openUserAbove` alone decided.
 *
 * Pure: the drain resolves the ids (`readInboxRowsByWireIds`) and asks.
 */
export function underPlacementKeepsSendOrder(input: {
  row: Pick<InboxOrderRow, 'commandId' | 'payload' | 'createdAt'>;
  siblings: ReadonlyArray<{
    wireMessageId: string;
    row: Pick<InboxOrderRow, 'commandId' | 'payload' | 'createdAt'> | null;
  }>;
}): boolean {
  for (const sibling of input.siblings) {
    if (sibling.row === null) continue;
    if (!inboxSentAfter(sibling.row, input.row)) return false;
  }
  return true;
}
