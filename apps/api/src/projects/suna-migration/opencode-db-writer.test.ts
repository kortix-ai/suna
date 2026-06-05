import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConversations } from './opencode-db-writer';
import { normalizeAgentpressThread, type AgentpressMessageRow } from './agentpress-mapper';

// Mirror the opencode tables the repo confirms (session: legacy-migration-steps.ts:124)
// plus a plausible message/part layout. The writer is schema-adaptive, so this is
// the contract we validate the WRITER against; real columns are introspected at apply.
function freshOpencodeDb(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, time_created INTEGER, time_initialized INTEGER);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, slug TEXT,
                          time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
  `);
  db.close();
}

describe('writeConversations', () => {
  test('writes a project/session/messages/parts that the migration enumerate query can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-writer-'));
    const dbPath = join(dir, 'opencode.db');
    try {
      freshOpencodeDb(dbPath);

      const rows: AgentpressMessageRow[] = [
        { message_id: 'a', type: 'user', is_llm_message: true, content: { role: 'user', content: 'Olá' }, created_at: '2026-03-31T01:00:00Z' },
        { message_id: 'b', type: 'assistant', is_llm_message: true, content: { role: 'assistant', content: 'feito', tool_calls: [{ id: 't1', type: 'function', function: { name: 'complete', arguments: '{"text":"ok"}' } }] }, created_at: '2026-03-31T01:00:01Z' },
        { message_id: 'c', type: 'tool', is_llm_message: true, content: { role: 'tool', tool_call_id: 't1', content: '{"status":"complete"}' }, created_at: '2026-03-31T01:00:02Z' },
      ];
      const messages = normalizeAgentpressThread(rows);

      const res = writeConversations(dbPath, 'proj_test', [{ title: 'Formação em Cardiologia', messages }]);
      expect(res.unknownTables).toEqual([]);          // all tables resolved
      expect(res).toMatchObject({ sessions: 1, messages: 2, parts: 3 }); // user text + assistant text + tool

      // The SAME query the live system uses to list sessions (legacy-migration-steps.ts).
      const db = new Database(dbPath, { readonly: true });
      try {
        const sessions = db.query(
          "select id, coalesce(nullif(title,''), slug, id) as title from session where parent_id is null and time_archived is null order by time_updated desc",
        ).all() as Array<{ id: string; title: string }>;
        expect(sessions).toHaveLength(1);
        expect(sessions[0].title).toBe('Formação em Cardiologia');

        const msgs = db.query('select * from message order by time_created').all() as any[];
        expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);

        // tool part carries parsed input + folded output
        const toolPart = (db.query("select data from part where type='tool'").all() as any[])
          .map((r) => JSON.parse(r.data))[0];
        expect(toolPart.tool).toBe('complete');
        expect(toolPart.state.status).toBe('completed');
        expect(toolPart.state.input).toEqual({ text: 'ok' });
        expect(toolPart.state.output).toBe('{"status":"complete"}');
      } finally { db.close(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports unknown tables instead of silently dropping (schema drift guard)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-writer2-'));
    const dbPath = join(dir, 'opencode.db');
    try {
      const db = new Database(dbPath);
      db.exec('CREATE TABLE project (id TEXT PRIMARY KEY); CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, parent_id TEXT, time_archived INTEGER, time_updated INTEGER);');
      db.close();
      const res = writeConversations(dbPath, 'p', [{ title: 't', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: '2026-01-01T00:00:00Z', sourceMessageId: 'x' }] }]);
      expect(res.unknownTables.sort()).toEqual(['message', 'part']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
