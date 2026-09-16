import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { sandboxRecordQuery } from './backend';

/**
 * INC-2026-09-15. `loadSandbox` read the session's agent through a raw `sql`
 * subquery inside a single-table select. Drizzle strips table qualifiers from
 * column references in a single-table selection, so the correlation rendered as
 * `where "session_id" = "session_id"` — true for every row — and every proxied
 * request received the agent of the FIRST tuple of `kortix.project_sessions`
 * (another customer's `chief-of-staff`). Agent-less prompts then re-pointed the
 * session token at that name. These assertions pin the rendered SQL.
 */
describe('sandboxRecordQuery — the agent comes from THIS session row', () => {
  const rendered = sandboxRecordQuery(sql`true`).toSQL().sql;

  test('joins project_sessions on the fully qualified session id', () => {
    expect(rendered).toContain('left join "kortix"."project_sessions"');
    expect(rendered).toContain(
      '"kortix"."project_sessions"."session_id" = "kortix"."session_sandboxes"."session_id"',
    );
  });

  test('never renders an unqualified self-comparison', () => {
    expect(rendered).not.toMatch(/"session_id"\s*=\s*"session_id"/);
  });

  test('reads agent_name from the joined row, not from a scalar subquery', () => {
    expect(rendered).toContain('"kortix"."project_sessions"."agent_name"');
    expect(rendered).not.toMatch(/\(\s*select\s+"agent_name"/i);
  });
});
