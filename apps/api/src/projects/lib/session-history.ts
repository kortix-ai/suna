import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { sessionWorkerLog, type Database } from '@kortix/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { wireIdTime } from '../wire-message-id';

export async function readSessionHistoryItems(
  database: Pick<Database, 'select'>,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await database
    .select({ item: sql<Record<string, unknown>>`CASE
      WHEN ${sessionWorkerLog.item}->>'kind' = 'history' THEN ${sessionWorkerLog.item}
      ELSE jsonb_build_object(
        'kind', 'journal', 'stream', 'kortix.pi.turn-admission.v1',
        'record', jsonb_strip_nulls(jsonb_build_object(
          'type', ${sessionWorkerLog.item}->'record'->>'type',
          'messageId', ${sessionWorkerLog.item}->'record'->>'messageId',
          'historyRevision', ${sessionWorkerLog.item}->'record'->'historyRevision',
          'turn', jsonb_build_object('messageId', ${sessionWorkerLog.item}->'record'->'turn'->>'messageId')
        ))
      ) END` })
    .from(sessionWorkerLog)
    .where(and(
      eq(sessionWorkerLog.sessionId, sessionId),
      sql`(${sessionWorkerLog.item}->>'kind' = 'history' OR (
        ${sessionWorkerLog.item}->>'kind' = 'journal' AND
        ${sessionWorkerLog.item}->>'stream' = 'kortix.pi.turn-admission.v1' AND
        ${sessionWorkerLog.item}->'record'->>'type' IN ('accepted', 'completed', 'cancelled')
      ))`,
    ))
    .orderBy(asc(sessionWorkerLog.id));
  return rows.map(row => row.item);
}

export async function readRewoundMessageFloor(
  database: Pick<Database, 'select'>,
  sessionId: string,
): Promise<bigint | null> {
  const [row] = await database.select({ floor: sql<string | null>`max((
    SELECT max(value) FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(${qualifiedColumn(sessionWorkerLog.item)}->'hiddenMessageIds') = 'array'
          THEN ${qualifiedColumn(sessionWorkerLog.item)}->'hiddenMessageIds'
        WHEN jsonb_typeof(${qualifiedColumn(sessionWorkerLog.item)}->'selection'->'hiddenMessageIds') = 'array'
          THEN ${qualifiedColumn(sessionWorkerLog.item)}->'selection'->'hiddenMessageIds'
        ELSE '[]'::jsonb
      END
    ) AS reserved(value)
    WHERE value ~ '^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$'
  ))` }).from(sessionWorkerLog).where(and(
    eq(sessionWorkerLog.sessionId, sessionId),
    sql`${qualifiedColumn(sessionWorkerLog.item)}->>'kind' = 'history'`,
  )).limit(1);
  return wireIdTime(row?.floor ?? '');
}
