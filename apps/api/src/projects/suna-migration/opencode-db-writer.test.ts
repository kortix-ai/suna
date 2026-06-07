import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConversations, seedOpencodeSchema } from './opencode-db-writer';
import { normalizeAgentpressThread, type AgentpressMessageRow } from './agentpress-mapper';

describe('writeConversations', () => {
  test('writes opencode-real rows (session NOT-NULL cols, message/part data blobs) opencode can serve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-writer-'));
    const dbPath = join(dir, 'opencode.db');
    try {
      seedOpencodeSchema(dbPath);

      const rows: AgentpressMessageRow[] = [
        { message_id: 'a', type: 'user', is_llm_message: true, content: { role: 'user', content: 'Olá' }, created_at: '2026-03-31T01:00:00Z' },
        { message_id: 'b', type: 'assistant', is_llm_message: true, content: { role: 'assistant', content: 'feito', tool_calls: [{ id: 't1', type: 'function', function: { name: 'complete', arguments: '{"text":"ok"}' } }] }, created_at: '2026-03-31T01:00:01Z' },
        { message_id: 'c', type: 'tool', is_llm_message: true, content: { role: 'tool', tool_call_id: 't1', content: '{"status":"complete"}' }, created_at: '2026-03-31T01:00:02Z' },
      ];
      const messages = normalizeAgentpressThread(rows);

      const res = writeConversations(dbPath, 'proj_test', [{ title: 'Formação em Cardiologia', messages }]);
      expect(res).toMatchObject({ sessions: 1, messages: 2, parts: 3 }); // user text + assistant text + tool

      const db = new Database(dbPath, { readonly: true });
      try {
        // The migration journal must be seeded so opencode skips re-migrating.
        const migs = db.query('select count(*) as n from __drizzle_migrations').get() as { n: number };
        expect(migs.n).toBe(8);

        // opencode lists sessions scoped to the workspace directory.
        const sessions = db.query("select id, title, slug, directory, version from session where directory = '/workspace'").all() as any[];
        expect(sessions).toHaveLength(1);
        expect(sessions[0].title).toBe('Formação em Cardiologia');
        expect(sessions[0].slug).toBeTruthy();   // NOT NULL
        expect(sessions[0].version).toBeTruthy(); // NOT NULL
        expect(res.sessionIds[0].id).toBe(sessions[0].id);

        // project carries the NOT-NULL worktree/sandboxes opencode requires.
        const proj = db.query('select worktree, sandboxes from project').get() as any;
        expect(proj.worktree).toBe('/workspace');
        expect(proj.sandboxes).toBe('[]');

        // message.data holds the role (no role column in real schema).
        const msgs = db.query('select data from message order by time_created').all() as any[];
        expect(msgs.map((m) => JSON.parse(m.data).role)).toEqual(['user', 'assistant']);

        // tool part: type/tool/state live in the data blob, input parsed + output folded.
        const toolPart = (db.query('select data from part').all() as any[])
          .map((r) => JSON.parse(r.data)).find((d) => d.type === 'tool');
        expect(toolPart.tool).toBe('complete');
        expect(toolPart.state.status).toBe('completed');
        expect(toolPart.state.input).toEqual({ text: 'ok' });
        expect(toolPart.state.output).toBe('{"status":"complete"}');
      } finally { db.close(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('seedOpencodeSchema reproduces opencode real schema (session/message/part columns)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-schema-'));
    const dbPath = join(dir, 'opencode.db');
    try {
      seedOpencodeSchema(dbPath);
      const db = new Database(dbPath, { readonly: true });
      try {
        const cols = (t: string) => new Set((db.query(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((r) => r.name));
        // The NOT-NULL columns whose absence broke the old hand-authored schema.
        expect(cols('session')).toEqual(new Set(['id', 'project_id', 'parent_id', 'slug', 'directory', 'title', 'version', 'share_url', 'summary_additions', 'summary_deletions', 'summary_files', 'summary_diffs', 'revert', 'permission', 'time_created', 'time_updated', 'time_compacting', 'time_archived', 'workspace_id']));
        expect(cols('message')).toEqual(new Set(['id', 'session_id', 'time_created', 'time_updated', 'data']));
        expect(cols('part')).toEqual(new Set(['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data']));
        expect(cols('project').has('worktree')).toBe(true);
        expect(cols('project').has('sandboxes')).toBe(true);
      } finally { db.close(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
