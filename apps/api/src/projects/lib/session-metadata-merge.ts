import { projectSessions } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';

/**
 * Merge top-level session metadata in the UPDATE statement.
 *
 * The expression reads the current row value after PostgreSQL acquires the row
 * lock. A detached telemetry writer cannot overwrite a concurrent write with
 * metadata that it read before that write.
 */
export function projectSessionMetadataMerge(patch: Record<string, unknown>): SQL {
  return sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}
