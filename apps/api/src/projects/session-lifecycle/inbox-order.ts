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
    asc(inboxSentAtSql),
    asc(inboxWireIdSql),
    asc(sessionLifecycleCommands.commandId),
  ] as const;
}

/** Rows that precede `row` in the exact tuple used by {@link inboxOrderBy}. */
export function inboxPrecedesRow(row: InboxOrderRow) {
  const wireMessageId = (row.payload as { wireMessageId?: unknown } | null)?.wireMessageId;
  return sql`(${inboxSentAtSql}, ${inboxWireIdSql}, ${sessionLifecycleCommands.commandId})
    < (${inboxSendOrderMs(row)}::bigint, ${typeof wireMessageId === 'string' ? wireMessageId : ''}::text COLLATE "C", ${row.commandId}::uuid)`;
}

/** Rows that follow `row` in the exact tuple used by {@link inboxOrderBy}. */
export function inboxFollowsRow(row: InboxOrderRow) {
  const wireMessageId = (row.payload as { wireMessageId?: unknown } | null)?.wireMessageId;
  return sql`(${inboxSentAtSql}, ${inboxWireIdSql}, ${sessionLifecycleCommands.commandId})
    > (${inboxSendOrderMs(row)}::bigint, ${typeof wireMessageId === 'string' ? wireMessageId : ''}::text COLLATE "C", ${row.commandId}::uuid)`;
}
