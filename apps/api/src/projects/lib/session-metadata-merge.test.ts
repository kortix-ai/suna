import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { projectSessionMetadataMerge } from './session-metadata-merge';

describe('project session metadata merge', () => {
  test('merges telemetry into the current database value', () => {
    const query = new PgDialect().sqlToQuery(
      projectSessionMetadataMerge({
        session_start_timeline: { totalMs: 42 },
      }),
    );

    expect(query.sql).toContain('"project_sessions"."metadata"');
    expect(query.sql).toContain('coalesce(');
    expect(query.sql).toContain('||');
    expect(query.params).toEqual([
      JSON.stringify({
        session_start_timeline: { totalMs: 42 },
      }),
    ]);
  });
});
