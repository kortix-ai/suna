/**
 * The recovery's reader and converter on a REAL OpenCode 1.18.23 store.
 *
 * `fixtures/opencode-1.18.23-store.json` is the fixture of the deleted kortixd
 * export tests (`opencode-session-log.test.ts` at 9f8db29fc4d^): the rows
 * `opencode serve` wrote against a mock LLM (synthetic prompts) with text,
 * reasoning, todowrite and bash, a user image, a failing bash, a compaction,
 * a `task` sub-agent and a stopped bash call. Beside the store it holds the v1
 * mirror rows the API's old capture stored, so the converter is checked
 * against `fromV1` of exactly what the old backfill read.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromV1, SessionLogSchema, upcast, type SessionLog, type SessionLogMessage, type V1Row } from '@kortix/api-contract/session-log';
import { RECOVERY_ADAPTER_VERSION, recoverSessionLog, sidecarPaths } from './convert';
import { readOpenCodeStore, UnsupportedStoreError, type StoreSnapshot } from './opencode-store';
import fixture from './fixtures/opencode-1.18.23-store.json';

const SESSION = 'session-recover';
const ROOT = fixture.root;
const CHILD = fixture.children[0]!;
const store = fixture.after as StoreSnapshot;
const v1 = fixture.v1After as unknown as V1Row[];
const PNG_SHA = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';

const all = (log: SessionLog) => log.threads.flatMap((t) => t.messages);

/** The fields only the store gives (see convert.ts), removed so the rest compares with `fromV1`. */
function withoutStoreFields(log: SessionLog): unknown {
  const copy = structuredClone(log) as SessionLog & Record<string, unknown>;
  for (const key of ['title', 'created_at', 'restore_grade', 'grade_counts', 'harness', 'todos'] as const) delete copy[key];
  for (const thread of copy.threads) {
    thread.title = null;
    for (const m of thread.messages) {
      delete (m as Partial<SessionLogMessage>).seq;
      delete (m as Partial<SessionLogMessage>).producer;
      for (const b of m.blocks) {
        if (b.type === 'attachment') delete b.ref, delete b.bytes, delete b.sha256;
        if (b.type === 'tool_call') for (const c of b.result?.content ?? []) if (c.type === 'attachment') delete c.ref, delete c.sha256;
      }
    }
  }
  return copy;
}

/** A SQLite file with OpenCode's tables holding `rows`. `legacy` drops the columns and tables a 1.17 store may lack. */
function writeStore(path: string, rows: StoreSnapshot, legacy = false): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, directory text NOT NULL, title text NOT NULL, ${legacy ? '' : 'version text NOT NULL,'} time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    ${legacy ? '' : 'CREATE TABLE todo (session_id text NOT NULL, content text NOT NULL, status text NOT NULL, priority text NOT NULL, position integer NOT NULL);'}
    PRAGMA journal_mode = WAL;
  `);
  for (const s of rows.sessions) {
    if (legacy) db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run(s.id, 'prj', s.parent_id, '/workspace', s.title ?? '', s.time_created, s.time_created);
    else db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(s.id, 'prj', s.parent_id, '/workspace', s.title ?? '', s.version ?? '', s.time_created, s.time_created);
  }
  for (const m of rows.messages) db.query('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(m.id, m.session_id, m.time_created, m.time_updated, m.data);
  for (const p of rows.parts) db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(p.id, p.message_id, p.session_id, p.time_created, p.time_updated, p.data);
  if (!legacy) for (const t of rows.todos) db.query('INSERT INTO todo VALUES (?, ?, ?, ?, ?)').run(t.session_id, t.content, t.status, t.priority, t.position);
  db.close();
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-recover-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reading a copy of opencode.db', () => {
  test('reads back every session, message, part and todo row in OpenCode order', () => {
    const path = join(dir, 'opencode.db');
    writeStore(path, store);
    const read = readOpenCodeStore(path);
    expect(read.messages.map((m) => m.id)).toEqual(store.messages.map((m) => m.id));
    expect(read.parts.map((p) => p.id)).toEqual([...store.parts].sort((a, b) => (a.message_id + a.id < b.message_id + b.id ? -1 : 1)).map((p) => p.id));
    expect(read.sessions).toEqual(store.sessions);
    expect(read.todos).toEqual(store.todos);
  });

  test('a store without version, todo or event tables still reads; one without a part table is unsupported', () => {
    const path = join(dir, 'legacy.db');
    writeStore(path, store, true);
    const read = readOpenCodeStore(path);
    expect(read.sessions.every((s) => s.version === null)).toBe(true);
    expect(read.todos).toEqual([]);
    expect(recoverSessionLog({ sessionId: SESSION, rootId: ROOT, store: read }).log.harness.history[0]!.version).toBe('unknown');

    const broken = join(dir, 'broken.db');
    new Database(broken).exec('CREATE TABLE session (id text, title text, time_created integer); CREATE TABLE message (id text, session_id text, time_created integer, time_updated integer, data text);');
    expect(() => readOpenCodeStore(broken)).toThrow(UnsupportedStoreError);
  });
});

describe('the recovered log', () => {
  test('equals fromV1 of the mirror rows of the same store, apart from the fields only the store gives', () => {
    const ours = recoverSessionLog({ sessionId: SESSION, rootId: ROOT, store }).log;
    const theirs = fromV1({ session_id: SESSION, root_id: ROOT, rows: v1 }, { harness: 'opencode' });
    expect(withoutStoreFields(ours)).toEqual(withoutStoreFields(theirs));
    expect(all(ours).map((m) => m.seq)).toEqual(all(theirs).map((m) => m.seq));
  });

  test('passes SessionLogSchema and upcast, with producer, image ref, titles, todos and a native grade', () => {
    const { log, blobs, messages } = recoverSessionLog({ sessionId: SESSION, rootId: ROOT, store });
    expect(SessionLogSchema.safeParse(log).success).toBe(true);
    expect(() => upcast(log)).not.toThrow();
    expect(messages).toBe(all(log).length);
    for (const m of all(log)) expect(m.producer).toEqual({ harness: 'opencode', harness_version: '1.18.23', adapter_version: RECOVERY_ADAPTER_VERSION });
    const image = all(log).flatMap((m) => m.blocks).find((b) => b.type === 'attachment');
    expect(image).toMatchObject({ type: 'attachment', mime: 'image/png', name: 'dot.png', ref: `blob:${PNG_SHA}`, bytes: 70, sha256: PNG_SHA });
    expect(blobs.get(PNG_SHA)).toMatchObject({ mime: 'image/png' });
    expect(blobs.get(PNG_SHA)!.data.length).toBe(70);
    expect(JSON.stringify(log)).not.toContain('data:image/png');
    expect(log).toMatchObject({
      title: 'Fixture session',
      restore_grade: 'native',
      harness: { current: 'opencode', history: [{ harness: 'opencode', version: '1.18.23', from_seq: 1 }] },
      todos: [{ content: 'Create hello.txt', status: 'completed', priority: 'high' }, { content: 'Check the image', status: 'pending', priority: 'medium' }],
    });
    expect(log.threads.map((t) => t.title)).toEqual(['Fixture session', 'list files (@general subagent)']);
  });

  test('the task child is a thread spawned by the task call', () => {
    const { log } = recoverSessionLog({ sessionId: SESSION, rootId: ROOT, store });
    const [root, child] = log.threads;
    const task = root!.messages.flatMap((m) => m.blocks.map((b) => ({ m, b }))).find(({ b }) => b.type === 'tool_call' && b.name === 'task')!;
    expect(child).toMatchObject({ thread_id: CHILD, parent_thread_id: ROOT, spawned_by: { message_id: task.m.message_id } });
    expect(child!.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  test('with no known root, fromV1 picks the root; the result is the same log', () => {
    const named = recoverSessionLog({ sessionId: SESSION, rootId: ROOT, store }).log;
    const guessed = recoverSessionLog({ sessionId: SESSION, rootId: null, store }).log;
    expect(guessed.threads.map((t) => t.thread_id)).toEqual(named.threads.map((t) => t.thread_id));
    expect(all(guessed).length).toBe(all(named).length);
  });

  test('an offloaded image resolves from its downloaded sidecar; a missing sidecar stays unresolved, never a failure', () => {
    const offloaded = structuredClone(store);
    const part = offloaded.parts.find((p) => JSON.parse(p.data).type === 'file')!;
    const data = JSON.parse(part.data);
    data.url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    data.kortix = { offloaded: true, sidecar: '/home/kortix/.local/share/kortix/attachments/prt_x' };
    part.data = JSON.stringify(data);
    expect(sidecarPaths(offloaded)).toEqual(['/home/kortix/.local/share/kortix/attachments/prt_x']);

    const bytes = Buffer.from('sidecar bytes');
    const found = recoverSessionLog({ sessionId: SESSION, rootId: ROOT, store: offloaded, sidecars: new Map([[data.kortix.sidecar, bytes]]) });
    // Validate before matching: bun's toMatchObject writes an asymmetric matcher into the object it checks.
    expect(SessionLogSchema.safeParse(found.log).success).toBe(true);
    const image = all(found.log).flatMap((m) => m.blocks).find((b) => b.type === 'attachment') as { bytes?: number; ref?: string };
    expect(image.bytes).toBe(bytes.length);
    expect(image.ref).toStartWith('blob:');

    const missing = recoverSessionLog({ sessionId: SESSION, rootId: ROOT, store: offloaded });
    const unresolved = all(missing.log).flatMap((m) => m.blocks).find((b) => b.type === 'attachment');
    expect(unresolved).not.toHaveProperty('ref');
    expect(missing.blobs.size).toBe(0);
    expect(SessionLogSchema.safeParse(missing.log).success).toBe(true);
  });
});
