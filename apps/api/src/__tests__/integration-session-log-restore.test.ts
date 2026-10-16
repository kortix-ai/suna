/**
 * Integration test (real PostgreSQL, fresh migrated database, real routes): the
 * session-log restore (P6.1), `POST .../log/restore`. A fresh box's daemon calls it
 * before its harness starts: it claims the session (generation + 1, under the
 * session's advisory lock) and reads back the whole stored log, the rev of every
 * message and the texts stored by reference.
 *
 * Real: every row, the journal, restore and attachment routes, the session PATs.
 * Fake: the Storage bucket (`helpers/fake-session-storage.ts`), which answers as
 * Supabase Storage does.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { SessionLogRestoreSchema, SessionLogRestoreTooLargeSchema, type SessionLogRestore } from '@kortix/api-contract/session-log';
import { accountMembers, sessionLogMessages, sessionLogs, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const bucket = fakeSessionStorage();
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ storage: bucket.storage }) }));

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');

const OWNER = crypto.randomUUID();
const REV = 1_791_681_474_704_000;
const T = '2026-10-11T10:00:00.000Z';
// Synthetic: 400,000 base64 characters, over the 256 kB offload threshold.
const TOOL_OUTPUT = randomBytes(300_000).toString('base64');

let project: SeededProject;
let session = '';
let bare = '';
let big = '';
let empty = '';
let ordered = '';
const tokens: Record<string, string> = {};
let ownerToken = '';

const producer = { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1' };
const message = (id: string, thread: string, seq: number, over: Record<string, unknown> = {}) => ({
  schema: 'kortix.session/2', v: 1, message_id: id, thread_id: thread, seq,
  role: 'user', kind: 'turn', status: 'complete', in_context: true,
  model: null, usage: null, finish: null, error: null,
  created_at: T, completed_at: null, producer, blocks: [{ type: 'text', id: `prt_${id}`, text: `text of ${id}` }], ext: {}, ...over,
});
const toolCall = (id: string, output: string) => ({
  type: 'tool_call', id, call_id: `call_${id}`, name: 'bash', kind: 'shell', input: { command: 'cat big.log' },
  status: 'complete', result: { content: [{ type: 'text', text: output }], is_error: false, exit_code: 0 },
});
const threadRecord = (id: string, parent: string | null, over: Record<string, unknown> = {}) => ({
  schema: 'kortix.session/2', v: 1, thread_id: id, parent_thread_id: parent, spawned_by: null,
  agent: null, title: null, created_at: T, ext: {}, ...over,
});
const sessionPatch = (sessionId: string) => ({
  schema: 'kortix.session/2', v: 1, session_id: sessionId, title: 'Synthetic session', created_at: T,
  restore_grade: 'partial', grade_counts: { tool_input: 1, cut_point: 0, attachment: 0 },
  harness: { current: 'opencode', history: [] },
  selection: { agent: 'build', model: null }, todos: [], pending: { questions: [], permissions: [] }, ext: {},
});

type Batch = { generation: number; puts: unknown[]; tombstones: unknown[]; threads: unknown[]; session?: unknown };
const base = (sessionId: string) => `/v1/projects/${project.project_id}/sessions/${sessionId}`;
const journal = (sessionId: string, body: Batch) =>
  app.request(`${base(sessionId)}/log/journal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${tokens[sessionId]}` },
    body: Bun.gzipSync(JSON.stringify(body)) as BodyInit,
  });
const restore = (sessionId: string, token = tokens[sessionId]!, headers: Record<string, string> = {}) =>
  app.request(`${base(sessionId)}/log/restore`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers } });
const generationOf = async (sessionId: string) =>
  (await db.select({ generation: sessionLogs.generation }).from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId)))[0]?.generation;
const stored = async (sessionId: string, id: string) =>
  (await db.select().from(sessionLogMessages).where(and(eq(sessionLogMessages.sessionId, sessionId), eq(sessionLogMessages.messageId, id))))[0]!;

// The session under test: a root thread and a sub-agent thread, one tombstone, one
// out-of-context message, one tool output stored by reference. Puts arrive out of seq order.
const u0 = message('msg_u0', 'main', 0);
const a1 = message('msg_a1', 'main', 1, { role: 'assistant', finish: 'tool_calls', blocks: [toolCall('prt_tool', TOOL_OUTPUT)] });
const old2 = message('msg_old2', 'main', 2, { in_context: false, hidden_reason: 'superseded' });
const gone3 = message('msg_gone3', 'main', 3, { role: 'assistant', finish: 'stop' });
const u4 = message('msg_u4', 'main', 4);
const c0 = message('msg_c0', 'ses_child', 0);
const c1 = message('msg_c1', 'ses_child', 1, { role: 'assistant', finish: 'stop' });
const main = threadRecord('main', null);
const child = threadRecord('ses_child', 'main', { spawned_by: { message_id: 'msg_a1', call_id: 'call_prt_tool' }, agent: 'explore' });
const revOf: Record<string, number> = { msg_u4: REV + 5, msg_c1: REV + 7, msg_a1: REV + 2, msg_u0: REV + 1, msg_gone3: REV + 4, msg_c0: REV + 6, msg_old2: REV + 3 };

beforeAll(async () => {
  project = await seedProject('session-log-restore');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  [session, bare, big, empty, ordered] = await Promise.all(Array.from({ length: 5 }, () => seedSession(project, OWNER)));
  for (const sessionId of [session, bare, big, empty, ordered]) {
    // A session PAT authenticates only while its sandbox row is live (the session lease).
    await db.insert(sessionSandboxes).values({ sandboxId: sessionId, sessionId, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
    tokens[sessionId] = (await createAccountToken({ accountId: project.account_id, userId: OWNER, projectId: project.project_id, sessionId, name: `restore-${sessionId.slice(0, 8)}` })).secretKey;
  }
  ownerToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'session-log-restore-owner' })).secretKey;

  const puts = [u4, c1, a1, u0, gone3, c0, old2].map((m) => ({ rev: revOf[m.message_id]!, message: m }));
  expect((await journal(session, { generation: 0, session: sessionPatch(session), threads: [main, child], puts, tombstones: [] })).status).toBe(200);
  expect((await journal(session, { generation: 0, puts: [], threads: [], tombstones: [{ message_id: 'msg_gone3', rev: REV + 20 }] })).status).toBe(200);
});

const MAX_BYTES = config.SESSION_LOG_RESTORE_MAX_BYTES;

afterAll(async () => {
  config.SESSION_LOG_RESTORE_ENABLED = true;
  config.SESSION_LOG_RESTORE_MAX_BYTES = MAX_BYTES;
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, project.account_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
  await removeSeeded([project]);
});

describe('POST .../log/restore', () => {
  test('a session without a stored log → 404 no_session_log; nothing is claimed', async () => {
    const res = await restore(empty);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_session_log' });
    expect(await generationOf(empty)).toBeUndefined();
  });

  test('a user token, or another session sandbox credential → 403; nothing is claimed', async () => {
    expect((await restore(session, ownerToken)).status).toBe(403);
    expect((await restore(session, tokens[bare]!)).status).toBe(403);
    expect(await generationOf(session)).toBe(0);
  });

  test('SESSION_LOG_RESTORE_ENABLED=false → 503; nothing is claimed', async () => {
    config.SESSION_LOG_RESTORE_ENABLED = false;
    try {
      expect((await restore(session)).status).toBe(503);
    } finally {
      config.SESSION_LOG_RESTORE_ENABLED = true;
    }
    expect(await generationOf(session)).toBe(0);
  });

  let claimed: SessionLogRestore;
  test('the claim raises the generation by 1 and answers the stored log, every rev and every stored-by-reference text', async () => {
    const res = await restore(session);
    expect(res.status).toBe(200);
    claimed = SessionLogRestoreSchema.parse(await res.json());
    expect(claimed.generation).toBe(1);
    expect(await generationOf(session)).toBe(1);

    // The tool output is the stored preview + ref + bytes, never the full text.
    const a1Stored = (await stored(session, 'msg_a1')).record as typeof a1;
    const item = (a1Stored.blocks[0] as unknown as { result: { content: Array<{ text: string; ref: string; bytes: number }> } }).result.content[0]!;
    expect(item.bytes).toBe(400_000);
    expect(item.text.length).toBe(16 * 1024);

    expect(claimed.log).toEqual({
      ...sessionPatch(session),
      threads: [
        // Live messages in seq order; the out-of-context one is in, the tombstoned one is out.
        { ...main, messages: [u0, a1Stored, old2, u4] },
        { ...child, messages: [c0, c1] },
      ],
    } as never);
    expect(claimed.revs).toEqual({ ...revOf, msg_gone3: REV + 20 });
    expect(claimed.seq_max).toEqual({ main: 4, ses_child: 1 });
    expect(claimed.blobs).toEqual([
      { message_id: 'msg_a1', block_id: 'prt_tool', ref: item.ref, bytes: 400_000, sha256: createHash('sha256').update(TOOL_OUTPUT).digest('hex') },
    ]);
  });

  test('a box still journaling at the old generation → 409 with the new one; the claimant journals at it → 200', async () => {
    const zombie = await journal(session, { generation: 0, puts: [{ rev: REV + 30, message: message('msg_zombie', 'main', 5) }], tombstones: [], threads: [] });
    expect(zombie.status).toBe(409);
    expect(await zombie.json()).toEqual({ generation: 1 });
    const fresh = await journal(session, { generation: 1, puts: [{ rev: REV + 31, message: message('msg_u5', 'main', 5) }], tombstones: [], threads: [] });
    expect(fresh.status).toBe(200);

    // A second claim fences the first claimant the same way.
    const again = SessionLogRestoreSchema.parse(await (await restore(session)).json());
    expect(again.generation).toBe(2);
    expect(again.revs.msg_u5).toBe(REV + 31);
    expect((await journal(session, { generation: 1, puts: [{ rev: REV + 32, message: message('msg_u6', 'main', 6) }], tombstones: [], threads: [] })).status).toBe(409);
  });

  test('the daemon reads the full text through the attachments route with its own credential; the id under another folder is 404', async () => {
    const ref = claimed.blobs[0]!.ref;
    const attachmentId = ref.split('/').at(-1)!;
    const own = await app.request(`${base(session)}/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${tokens[session]}` } });
    expect(own.status).toBe(200);
    const text = await own.text();
    expect(createHash('sha256').update(text).digest('hex')).toBe(claimed.blobs[0]!.sha256);
    expect(text).toBe(TOOL_OUTPUT);
    // The object id under another session's folder names no object.
    const misplaced = await app.request(`${base(bare)}/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${tokens[bare]}` } });
    expect(misplaced.status).toBe(404);
  });

  test('a log stored without a session patch or thread upserts still answers a valid SessionLog; seq_max counts a tombstone', async () => {
    const puts = [{ rev: REV + 1, message: message('msg_b0', 'thr_unknown', 0) }, { rev: REV + 2, message: message('msg_b5', 'thr_unknown', 5) }];
    expect((await journal(bare, { generation: 0, puts, tombstones: [], threads: [] })).status).toBe(200);
    // The thread's last message is tombstoned: the next message must still number above it.
    expect((await journal(bare, { generation: 0, puts: [], threads: [], tombstones: [{ message_id: 'msg_b5', rev: REV + 3 }] })).status).toBe(200);
    const res = await restore(bare);
    expect(res.status).toBe(200);
    const body = SessionLogRestoreSchema.parse(await res.json());
    expect(body.log.session_id).toBe(bare);
    expect(body.log.harness.current).toBe('opencode');
    expect(body.log.restore_grade).toBe('native');
    expect(body.log.threads).toEqual([expect.objectContaining({ thread_id: 'thr_unknown', parent_thread_id: null, messages: [puts[0]!.message] })] as never);
    expect(body.seq_max).toEqual({ thr_unknown: 5 });
    expect(body.blobs).toEqual([]);
  });

  test('gzip when the request accepts it: a 500-message session', async () => {
    const turn = (i: number) => [
      message(`msg_q${i}`, 'main', 2 * i, { blocks: [{ type: 'text', id: `prt_q${i}`, text: `Question ${i}: list the files under src/module-${i} and explain each one in two sentences.` }] }),
      message(`msg_r${i}`, 'main', 2 * i + 1, {
        role: 'assistant', finish: 'stop',
        usage: { input: 12_000 + i, output: 350, reasoning: 40, cache_read: 9_000, cache_write: 0 },
        blocks: [
          { type: 'reasoning', id: `prt_t${i}`, text: `The user wants the files of module ${i}. I list them first.` },
          toolCall(`prt_l${i}`, Array.from({ length: 30 }, (_, k) => `src/module-${i}/file-${k}.ts`).join('\n')),
          { type: 'text', id: `prt_a${i}`, text: `Module ${i} holds 30 files. `.repeat(12) },
        ],
      }),
    ];
    const puts = Array.from({ length: 250 }, (_, i) => turn(i)).flat().map((m, i) => ({ rev: REV + i, message: m }));
    expect((await journal(big, { generation: 0, session: sessionPatch(big), threads: [main], puts, tombstones: [] })).status).toBe(200);

    const res = await restore(big, tokens[big]!, { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    const gz = new Uint8Array(await res.arrayBuffer());
    const raw = gunzipSync(gz);
    const body = SessionLogRestoreSchema.parse(JSON.parse(raw.toString('utf8')));
    expect(body.log.threads[0]!.messages).toHaveLength(500);
    expect(Object.keys(body.revs)).toHaveLength(500);
    console.info(`[restore size] 500 messages: ${raw.byteLength} bytes raw, ${gz.byteLength} bytes gzipped`);
    expect(gz.byteLength).toBeLessThan(raw.byteLength / 4);

    // Without Accept-Encoding the answer is plain JSON: the same log, one generation on.
    const plain = await restore(big);
    expect(plain.headers.get('content-encoding')).toBeNull();
    const plainBody = SessionLogRestoreSchema.parse(await plain.json());
    expect(plainBody.generation).toBe(2);
    expect({ ...plainBody, generation: 1 }).toEqual(body);
  });

  test('the cap: a log at SESSION_LOG_RESTORE_MAX_BYTES answers 200; one byte over → 413 session_log_too_large, claimed, every thread, rev and seq, no message', async () => {
    // The 500-message session of the gzip test: 1 tombstone more, which the size leaves out.
    expect((await journal(big, { generation: 2, puts: [], threads: [], tombstones: [{ message_id: 'msg_q0', rev: REV + 1_000 }] })).status).toBe(200);
    const [row] = await db.execute<{ bytes: string }>(sql`select sum(octet_length(record::text)) as bytes from kortix.session_log_messages where session_id = ${big} and deleted_at is null`);
    const bytes = Number(row!.bytes);
    expect(bytes).toBeGreaterThan(100_000);
    try {
      config.SESSION_LOG_RESTORE_MAX_BYTES = bytes;
      const at = await restore(big);
      expect(at.status).toBe(200);
      expect(SessionLogRestoreSchema.parse(await at.json()).log.threads[0]!.messages).toHaveLength(499);
      expect(await generationOf(big)).toBe(3);

      config.SESSION_LOG_RESTORE_MAX_BYTES = bytes - 1;
      const over = await restore(big, tokens[big]!, { 'Accept-Encoding': 'gzip' });
      expect(over.status).toBe(413);
      expect(over.headers.get('content-encoding')).toBe('gzip');
      const text = gunzipSync(new Uint8Array(await over.arrayBuffer())).toString('utf8');
      const body = SessionLogRestoreTooLargeSchema.parse(JSON.parse(text));
      console.info(`[restore size] over the cap: ${text.length} bytes for a ${bytes}-byte log`);
      expect(body).toMatchObject({ error: 'session_log_too_large', bytes, limit: bytes - 1, messages: 499, generation: 4, seq_max: { main: 499 }, blobs: [] });
      // The claim stands: the box journals at 4, and the old claimant gets 409.
      expect(await generationOf(big)).toBe(4);
      expect(body.log.session_id).toBe(big);
      expect(body.log.title).toBe('Synthetic session');
      expect(body.log.threads).toEqual([{ ...main, messages: [] }] as never);
      expect(Object.keys(body.revs)).toHaveLength(500);
      expect(body.revs.msg_q0).toBe(REV + 1_000);
      expect((await journal(big, { generation: 3, puts: [{ rev: REV + 2_000, message: message('msg_late', 'main', 500) }], tombstones: [], threads: [] })).status).toBe(409);
      expect((await journal(big, { generation: 4, puts: [{ rev: REV + 2_001, message: message('msg_note', 'main', 500) }], tombstones: [], threads: [] })).status).toBe(200);
    } finally {
      config.SESSION_LOG_RESTORE_MAX_BYTES = MAX_BYTES;
    }
  });

  test('a tool_call input keeps the key order the harness wrote, at every depth; a row without the order restores as jsonb sorted it', async () => {
    // Keys out of jsonb order (jsonb sorts by length, then bytes) at every depth, in objects inside arrays,
    // and an integer-like key (a JS object puts it first, in the harness as here).
    const input = { zeta: 'last-alphabetically', command: 'ls -la', options: { recursive: true, depth: 2, filter: { suffix: '.ts', prefix: 'src/' } }, items: [{ to: 'b', from: 'a' }, 'x', [{ yy: 1, a: 2 }]], '10': 'n', mid: null };
    const call = (id: string, over: Record<string, unknown> = {}) => ({ ...toolCall(id, 'ok'), name: 'custom', kind: 'other', input, ...over });
    const m0 = message('msg_o0', 'main', 0, { role: 'assistant', finish: 'tool_calls', blocks: [{ type: 'text', id: 'prt_o0t', text: 'calling' }, call('prt_o0a'), call('prt_o0b', { input: 'freeform text input' })] });
    const m1 = message('msg_o1', 'main', 1, { role: 'assistant', finish: 'tool_calls', blocks: [call('prt_o1a')] });
    const puts = [m0, m1].map((m, i) => ({ rev: REV + i, message: m }));
    expect((await journal(ordered, { generation: 0, session: sessionPatch(ordered), threads: [main], puts, tombstones: [] })).status).toBe(200);

    // The control: the jsonb record has the keys sorted, so this test can fail.
    const sorted = JSON.stringify(((await stored(ordered, 'msg_o0')).record as { blocks: Array<{ input: unknown }> }).blocks[1]!.input);
    expect(sorted).not.toBe(JSON.stringify(input));
    expect(sorted.startsWith('{"10":"n","mid":null,"zeta":')).toBe(true);
    expect((await stored(ordered, 'msg_o0')).toolInputOrder).toEqual([null, expect.anything(), null]);

    // A row written before the column (no order) restores as jsonb sorted it.
    await db.update(sessionLogMessages).set({ toolInputOrder: null }).where(and(eq(sessionLogMessages.sessionId, ordered), eq(sessionLogMessages.messageId, 'msg_o1')));

    // The bytes the daemon reads: the raw answer body, not a re-serialized parse.
    const text = await (await restore(ordered)).text();
    const inputs = (JSON.parse(text) as SessionLogRestore).log.threads[0]!.messages.map((m) => m.blocks.flatMap((b) => (b.type === 'tool_call' ? [JSON.stringify(b.input)] : [])));
    expect(inputs).toEqual([[JSON.stringify(input), '"freeform text input"'], [sorted]]);
    expect(text).toContain(JSON.stringify(input));
    // The contract parse keeps the order too.
    const parsed = SessionLogRestoreSchema.parse(JSON.parse(text)).log.threads[0]!.messages[0]!.blocks[1]!;
    expect(JSON.stringify((parsed as { input: unknown }).input)).toBe(JSON.stringify(input));
  });
});
