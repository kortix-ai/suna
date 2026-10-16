/**
 * Integration test (real PostgreSQL, fresh migrated database, real routes): the
 * session-log journal ingest and manifest (P2.2) that kortixd's journal calls.
 *
 * Every request goes through `app.request` with a real session PAT (the
 * credential a session sandbox holds as `KORTIX_TOKEN`) and a gzipped body,
 * the way the daemon sends it. The assertions read the rows back.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectSessions, projects, sessionLogMessages, sessionLogThreads, sessionLogs, sessionSandboxes, sessionTurns } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const OTHER = crypto.randomUUID();
// A daemon journal revision: max(Date.now() * 1000, last + 1), past int4.
const REV = 1_791_681_474_704_000;
const T = '2026-10-11T10:00:00.000Z';

const tokens: Record<string, string> = {};
let ownerToken = '';

const producer = { harness: 'opencode', harness_version: '1.18.15', adapter_version: '1' };
const message = (id: string, seq: number, over: Record<string, unknown> = {}) => ({
  schema: 'kortix.session/2', v: 1, message_id: id, thread_id: 'main', seq,
  role: 'user', kind: 'turn', status: 'complete', in_context: true,
  model: null, usage: null, finish: null, error: null,
  created_at: T, completed_at: null, producer, blocks: [], ext: {}, ...over,
});
const thread = (id: string) => ({
  schema: 'kortix.session/2', v: 1, thread_id: id, parent_thread_id: null, spawned_by: null,
  agent: null, title: null, created_at: T, ext: {},
});
const sessionPatch = {
  schema: 'kortix.session/2', v: 1, session_id: SESSION, title: null, created_at: T,
  restore_grade: 'native', harness: { current: 'opencode', history: [] },
  selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] }, ext: {},
};

type Batch = { generation: number; puts: unknown[]; tombstones: unknown[]; threads: unknown[]; session?: unknown };
const batch = (b: Partial<Batch>): Batch => ({ generation: 0, puts: [], tombstones: [], threads: [], ...b });
const path = (sessionId: string, leaf: 'journal' | 'manifest') => `/v1/projects/${PROJECT}/sessions/${sessionId}/log/${leaf}`;

const journal = (body: Batch | Uint8Array, token = tokens[SESSION]!, sessionId = SESSION) =>
  app.request(path(sessionId, 'journal'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${token}` },
    body: (body instanceof Uint8Array ? body : Bun.gzipSync(JSON.stringify(body))) as BodyInit,
  });
const manifest = (token = tokens[SESSION]!) =>
  app.request(path(SESSION, 'manifest'), { headers: { Authorization: `Bearer ${token}` } });

const stored = (id: string) =>
  db
    .select({ rev: sessionLogMessages.rev, hash: sessionLogMessages.contentHash, deletedAt: sessionLogMessages.deletedAt, seq: sessionLogMessages.seq, record: sessionLogMessages.record })
    .from(sessionLogMessages)
    .where(and(eq(sessionLogMessages.sessionId, SESSION), eq(sessionLogMessages.messageId, id)))
    .then((rows) => rows[0]);
const messageCount = async () =>
  (await db.select({ id: sessionLogMessages.messageId }).from(sessionLogMessages).where(eq(sessionLogMessages.sessionId, SESSION))).length;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-log-ingest' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'session-log-ingest', repoUrl: 'https://example.test/session-log.git' });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' });
  for (const sessionId of [SESSION, OTHER]) {
    await db.insert(projectSessions).values({ sessionId, accountId: ACCOUNT, projectId: PROJECT, branchName: sessionId, createdBy: OWNER });
    // A session PAT authenticates only while its sandbox row is live (the session lease).
    await db.insert(sessionSandboxes).values({ sandboxId: sessionId, sessionId, accountId: ACCOUNT, projectId: PROJECT, status: 'active', config: {}, metadata: {} });
    tokens[sessionId] = (await createAccountToken({ accountId: ACCOUNT, userId: OWNER, projectId: PROJECT, sessionId, name: `session-log-${sessionId.slice(0, 8)}` })).secretKey;
  }
  ownerToken = (await createAccountToken({ accountId: ACCOUNT, userId: OWNER, name: 'session-log-owner' })).secretKey;
  // The turn whose user message is msg_u1: the journal marks it durable.
  await db.insert(sessionTurns).values({ turnToken: `turn-${SESSION}`, sessionId: SESSION, sandboxId: SESSION, projectId: PROJECT, accountId: ACCOUNT, messageId: 'msg_u1', state: 'active' });
});

afterAll(async () => {
  config.SESSION_LOG_INGEST_ENABLED = true;
  await db.delete(sessionTurns).where(eq(sessionTurns.accountId, ACCOUNT));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, ACCOUNT));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const first = batch({
  puts: [
    { rev: REV + 1, message: message('msg_u1', 0) },
    { rev: REV + 2, message: message('msg_a1', 1, { role: 'assistant', reply_to: 'msg_u1', finish: 'stop', completed_at: T }) },
  ],
  threads: [thread('main')],
  session: sessionPatch,
});

describe('journal', () => {
  test('a two-message batch answers 200 with both pairs, stores them, and marks the turn durable', async () => {
    const res = await journal(first);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acked: [{ message_id: 'msg_u1', rev: REV + 1 }, { message_id: 'msg_a1', rev: REV + 2 }] });
    const row = await stored('msg_a1');
    expect(row?.rev).toBe(REV + 2);
    expect(row?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const [log] = await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, SESSION));
    expect(log).toMatchObject({ generation: 0, harnessCurrent: 'opencode', restoreGrade: 'native', v: 1 });
    expect((log!.record as { session_id: string }).session_id).toBe(SESSION);
    const [turn] = await db.select({ at: sessionTurns.logDurableAt }).from(sessionTurns).where(eq(sessionTurns.sessionId, SESSION));
    expect(turn?.at).toBeInstanceOf(Date);
  });

  test('a replay of the same batch is idempotent: same acknowledgement, same rows, same durable time', async () => {
    const before = await stored('msg_u1');
    const durable = async () => (await db.select({ at: sessionTurns.logDurableAt }).from(sessionTurns).where(eq(sessionTurns.sessionId, SESSION)))[0]?.at;
    const firstDurable = await durable();
    // A daemon that restarts re-sends every message; the turn was durable at the first acknowledgement.
    await Bun.sleep(20);
    const res = await journal(first);
    expect(res.status).toBe(200);
    expect((await res.json()).acked).toHaveLength(2);
    expect(await stored('msg_u1')).toEqual(before);
    expect(await messageCount()).toBe(2);
    expect(await durable()).toEqual(firstDurable!);
  });

  test('a lone UTF-16 surrogate is stored as U+FFFD, never a 500 (KRTX-211 poison batch)', async () => {
    // A harness slicing an emoji in half emits `\ud83d` alone; JSON keeps it
    // ("\\ud83d") and Postgres jsonb rejects the escape — one such record
    // failed the whole 730 KB INSERT and the daemon retried it forever
    // (2026-10-12: 243 5xx on this route in a day). The ingest must sanitize
    // to U+FFFD, like a terminal, and ack the batch. Runs in the OTHER
    // session so the manifest test's exact message list stays closed.
    const res = await journal(batch({
      puts: [{ rev: REV + 70, message: message('msg_well', 7, { blocks: [{ type: 'text', id: 'blk_well', text: 'sliced emoji \ud83d done' }] }) }],
    }), tokens[OTHER]!, OTHER);
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ record: sessionLogMessages.record })
      .from(sessionLogMessages)
      .where(and(eq(sessionLogMessages.sessionId, OTHER), eq(sessionLogMessages.messageId, 'msg_well')));
    const block = (row!.record as { blocks: Array<{ id?: string; text?: string }> }).blocks.find((b) => b.id === 'blk_well');
    expect(block!.text).toBe('sliced emoji \uFFFD done');
  });

  test('nested own __proto__ JSON data survives journal persistence', async () => {
    const future = JSON.parse('{"__proto__":{"kept":"😀 café"},"nested":[{"__proto__":{"note":"nul\\u0000"},"bad\\u0000key":"漢字"}]}');
    const record = message('msg_own_proto', 8, { future });
    expect((await journal(batch({ puts: [{ rev: REV + 71, message: record }] }), tokens[OTHER]!, OTHER)).status).toBe(200);
    const [row] = await db.select({ record: sessionLogMessages.record }).from(sessionLogMessages)
      .where(and(eq(sessionLogMessages.sessionId, OTHER), eq(sessionLogMessages.messageId, 'msg_own_proto')));
    expect(row?.record.future).toEqual(JSON.parse('{"__proto__":{"kept":"😀 café"},"nested":[{"__proto__":{"note":"nul�"},"bad�key":"漢字"}]}'));
  });

  test('the highest rev wins; a lower rev is acknowledged and changes nothing', async () => {
    const edited = message('msg_u1', 0, { status: 'aborted' });
    expect((await journal(batch({ puts: [{ rev: REV + 10, message: edited }] }))).status).toBe(200);
    const applied = await stored('msg_u1');
    expect(applied?.rev).toBe(REV + 10);
    expect(applied?.record).toEqual(edited);

    const stale = await journal(batch({ puts: [{ rev: REV + 5, message: message('msg_u1', 0, { status: 'error' }) }] }));
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ acked: [{ message_id: 'msg_u1', rev: REV + 5 }] });
    expect(await stored('msg_u1')).toEqual(applied);
  });

  test('a record keeps fields this API does not know', async () => {
    const future = message('msg_u2', 2, { future_field: { kept: true } });
    expect((await journal(batch({ puts: [{ rev: REV + 11, message: future }] }))).status).toBe(200);
    expect((await stored('msg_u2'))?.record).toEqual(future);
  });

  test('a tombstone is a revision: it deletes, keeps the seq, and a lower put does not revive', async () => {
    const res = await journal(batch({ tombstones: [{ message_id: 'msg_a1', rev: REV + 20 }] }));
    expect(await res.json()).toEqual({ acked: [{ message_id: 'msg_a1', rev: REV + 20 }] });
    const gone = await stored('msg_a1');
    expect(gone?.deletedAt).toBeInstanceOf(Date);
    expect(gone?.rev).toBe(REV + 20);
    expect(gone?.seq).toBe(1);

    const late = await journal(batch({ puts: [{ rev: REV + 15, message: message('msg_a1', 1, { role: 'assistant' }) }] }));
    expect(late.status).toBe(200);
    expect((await stored('msg_a1'))?.deletedAt).toBeInstanceOf(Date);
  });

  test('a seq another message of the thread holds answers 422 with the pair, and the batch writes nothing', async () => {
    const res = await journal(
      batch({
        puts: [
          { rev: REV + 30, message: message('msg_new', 3) },
          { rev: REV + 31, message: message('msg_dup', 1) }, // msg_a1 (tombstoned) holds seq 1
        ],
        threads: [thread('side')],
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'seq_conflict', message_id: 'msg_dup', rev: REV + 31, thread_id: 'main', seq: 1 });
    expect(await stored('msg_new')).toBeUndefined();
    const [side] = await db.execute(sql`select count(*)::int as n from kortix.session_log_threads where session_id = ${SESSION} and thread_id = 'side'`);
    expect((side as { n: number }).n).toBe(0);
  });

  test('a newer generation becomes the session generation; an older one answers 409 and writes nothing', async () => {
    expect((await journal(batch({ generation: 2, puts: [{ rev: REV + 40, message: message('msg_u3', 4) }] }))).status).toBe(200);
    const [log] = await db.select({ generation: sessionLogs.generation }).from(sessionLogs).where(eq(sessionLogs.sessionId, SESSION));
    expect(log?.generation).toBe(2);

    const zombie = await journal(batch({ generation: 1, puts: [{ rev: REV + 50, message: message('msg_zombie', 5) }], session: { title: 'zombie' } }));
    expect(zombie.status).toBe(409);
    expect(await zombie.json()).toEqual({ generation: 2 });
    expect(await stored('msg_zombie')).toBeUndefined();
    const [after] = await db.select({ record: sessionLogs.record }).from(sessionLogs).where(eq(sessionLogs.sessionId, SESSION));
    expect((after!.record as { title: unknown }).title).toBeNull();
  });

  test('a session patch merges into the record and the typed columns', async () => {
    const patch = { title: 'Renamed', restore_grade: 'partial', grade_counts: { tool_input: 1, cut_point: 0, attachment: 0 } };
    expect((await journal(batch({ generation: 2, session: patch }))).status).toBe(200);
    const [log] = await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, SESSION));
    expect(log).toMatchObject({ restoreGrade: 'partial', gradeCounts: patch.grade_counts, harnessCurrent: 'opencode' });
    expect(log!.record).toMatchObject({ title: 'Renamed', session_id: SESSION, restore_grade: 'partial' });
  });

  test('tool output with NUL and lone surrogates stores with each as U+FFFD, and content_hash stays the sanitized record', async () => {
    // A harness tool read a binary file: its result text carries NUL (\u0000) and lone
    // surrogate code units. Postgres jsonb refuses both (22P05, the prod incident:
    // `insert into "kortix"."session_log_messages"` fails and the daemon retries the
    // batch forever), so the ingest replaces each bad unit with U+FFFD in the stored
    // copy instead of answering 500 to the whole batch. A valid surrogate pair (an
    // emoji) survives.
    const put = {
      rev: REV + 60,
      message: message('msg_bin', 6, {
        role: 'assistant',
        producer: { harness: 'opencode\u0000', harness_version: '1.18.15', adapter_version: '1' },
        blocks: [
          {
            type: 'tool_call',
            id: 'blk_bin',
            call_id: 'call_bin',
            name: 'read',
            kind: 'read',
            status: 'complete',
            result: { content: [{ type: 'text', text: 'HTTP 200 2346\n \u0000,\u0000Q\u0000I\u0000H\u0000U\u0000H\u0000 end \uD83D tail' }], is_error: false, details: { note: 'nul\u0000' } },
            ext: { raw: { version: '1', data: 'x\u0000y' }, 'bad\u0000key': { version: '1', data: 'v' } },
          },
        ],
        ext: { out: { version: '1', data: 'ok \uD83D\uDE00 pair \uDE00 lone' } },
      }),
    };
    const res = await journal(batch({ generation: 2, puts: [put] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acked: [{ message_id: 'msg_bin', rev: REV + 60 }] });

    const row = await stored('msg_bin');
    // The KRTX-211 contract: content_hash describes the stored record — the
    // sanitized form. Built here with an independent walk (every string, keys
    // included; the /u class never matches inside a valid surrogate pair).
    const safe = (s: string): string => s.replace(/[\0\uD800-\uDFFF]/gu, '\uFFFD');
    const sanitized = JSON.parse(
      JSON.stringify(put.message, (_k, v: unknown) => {
        if (typeof v === 'string') return safe(v);
        if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([key, item]) => [safe(key), item]));
        return v;
      }),
    );
    expect(row?.hash).toBe(`sha256:${createHash('sha256').update(JSON.stringify(sanitized)).digest('hex')}`);
    const record = row!.record as {
      blocks: Array<{ result?: { content: Array<{ type: string; text: string }>; details?: unknown }; ext?: Record<string, unknown> }>;
      ext?: Record<string, unknown>;
      producer?: { harness: string };
    };
    expect(record.blocks[0]!.result!.content[0]).toEqual({ type: 'text', text: 'HTTP 200 2346\n \uFFFD,\uFFFDQ\uFFFDI\uFFFDH\uFFFDU\uFFFDH\uFFFD end \uFFFD tail' });
    expect(record.blocks[0]!.result!.details).toEqual({ note: 'nul\uFFFD' });
    expect(record.blocks[0]!.ext).toEqual({ raw: { version: '1', data: 'x\uFFFDy' }, 'bad\uFFFDkey': { version: '1', data: 'v' } });
    expect(record.ext).toEqual({ out: { version: '1', data: 'ok \uD83D\uDE00 pair \uFFFD lone' } });
    expect(record.producer!.harness).toBe('opencode\uFFFD');
    // Nothing jsonb refuses reached the row: Postgres renders a NUL as \u0000 and a
    // lone surrogate is not storable at all.
    const [text_row] = await db.execute(sql`select record::text as r, producer::text as p from kortix.session_log_messages where session_id = ${SESSION} and message_id = 'msg_bin'`);
    expect((text_row as { r: string }).r).not.toContain('\\u0000');
    expect((text_row as { r: string }).r).not.toContain('\\ud83d');
    expect((text_row as { r: string }).r).not.toContain('\\ude00');
    // The `producer` jsonb column is a projection of the record: sanitized too.
    expect(JSON.parse((text_row as { p: string }).p).harness).toBe('opencode\uFFFD');

    const [log] = await db.select({ harnessCurrent: sessionLogs.harnessCurrent }).from(sessionLogs).where(eq(sessionLogs.sessionId, SESSION));
    expect(log?.harnessCurrent).toBe('opencode');
  });

  test('a session patch and thread the stored columns cannot hold (a NUL) store as U+FFFD', async () => {
    // `harness_current` is a text column: a raw NUL byte fails the UPDATE with 22021
    // the way jsonb fails a \u0000 escape with 22P05. The patch record and the thread
    // record are jsonb; all three store sanitized.
    const res = await journal(
      batch({
        generation: 2,
        session: { title: 'read \u0000bin', harness: { current: 'opencode\u0000', history: [] } },
        threads: [{ ...thread('bin2'), ext: { note: { version: '1', data: 't\u0000' } } }],
      }),
    );
    expect(res.status).toBe(200);
    const [log] = await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, SESSION));
    expect(log).toMatchObject({ harnessCurrent: 'opencode\uFFFD' });
    expect(log!.record).toMatchObject({ title: 'read \uFFFDbin' });
    const [thread_row] = await db
      .select({ record: sessionLogThreads.record })
      .from(sessionLogThreads)
      .where(and(eq(sessionLogThreads.sessionId, SESSION), eq(sessionLogThreads.threadId, 'bin2')));
    expect(thread_row?.record).toEqual({ ...thread('bin2'), ext: { note: { version: '1', data: 't\uFFFD' } } });
  });

  test('a compaction marks only the turn that carries its id: the /summarize turn on both harnesses, never an id-less turn', async () => {
    // No assistant message answers a compaction: both harnesses fold the summary into it. Both
    // daemons relay `turn_begin` with the compaction id, and apps/api binds it to the /summarize
    // turn. A turn whose bind failed stays unmarked: a guess marked the wrong turn. One thread per
    // scenario, in the OTHER session.
    const at = (min: number) => new Date(Date.parse(T) + min * 60_000);
    const turn = (name: string, thread: string, start: number, messageId: string | null, end: number | null = null, sessionId = OTHER) => ({
      turnToken: `${name}-${sessionId}`, sessionId, sandboxId: sessionId, projectId: PROJECT, accountId: ACCOUNT, runtimeSessionId: thread, messageId,
      state: end === null ? 'active' : 'ended', startedAt: at(start), endedAt: end === null ? null : at(end),
    });
    await db.insert(sessionTurns).values([
      // The normal case (pi): a prompt, the /summarize named by its compaction, a later id-less turn.
      turn('pi_prompt', 'ses_pi', -10, 'msg_c_u1', -9),
      turn('pi_summarize', 'ses_pi', -5, 'msg_c_pi'),
      turn('pi_later', 'ses_pi', 5, null),
      // The same message id in another session.
      turn('other_session', 'ses_pi', -6, 'msg_c_pi', null, SESSION),
      // OpenCode: the same id match; an id-less turn open beside it stays unmarked.
      turn('oc_summarize', 'ses_oc', -5, 'msg_c_oc', -4),
      turn('oc_idless', 'ses_oc', -6, null),
      // A refused /summarize still open (its bind failed), then an auto compaction inside a prompt turn.
      turn('r_refused', 'ses_r', -8, null),
      turn('r_prompt', 'ses_r', -5, 'msg_r_u'),
      // A re-sent compaction: its turn was marked at the first acknowledgement; a delivery without a
      // wire id started before the compaction completed and is still open.
      { ...turn('x_summarize', 'ses_x', -5, null, -3), logDurableAt: at(-3) },
      turn('x_delivery', 'ses_x', -4.5, null),
      // A box clock 10 minutes ahead on a replay: an id-less turn started after the compaction.
      turn('z_later', 'ses_z', 5, null),
    ]);
    const compaction = (id: string, thread: string, completed: number) => ({
      rev: REV + 81,
      message: message(id, 0, {
        thread_id: thread, kind: 'compaction', created_at: at(completed).toISOString(), completed_at: at(completed).toISOString(),
        blocks: [{ type: 'compaction', id: `${id}-p0`, summary: 'the summary', first_kept_message_id: null, trigger: 'manual' }],
      }),
    });
    const res = await journal(batch({
      puts: [
        compaction('msg_c_pi', 'ses_pi', -4), compaction('msg_c_oc', 'ses_oc', -4), compaction('msg_c_r_auto', 'ses_r', -4),
        compaction('msg_c_x', 'ses_x', -4), compaction('msg_c_z', 'ses_z', 10),
      ],
      threads: ['ses_pi', 'ses_oc', 'ses_r', 'ses_x', 'ses_z'].map(thread),
    }), tokens[OTHER]!, OTHER);
    expect(res.status).toBe(200);
    const rows = await db.select({ token: sessionTurns.turnToken, at: sessionTurns.logDurableAt }).from(sessionTurns).where(eq(sessionTurns.accountId, ACCOUNT));
    const durable = Object.fromEntries(rows.filter((r) => r.token !== `turn-${SESSION}`).map((r) => [r.token.replace(/-[0-9a-f-]{36}$/, ''), r.at !== null]));
    expect(durable).toEqual({
      pi_prompt: false, pi_summarize: true, pi_later: false, other_session: false, oc_summarize: true, oc_idless: false,
      r_refused: false, r_prompt: false, x_summarize: true, x_delivery: false, z_later: false,
    });
    // The first acknowledgement's time stays.
    expect(rows.find((r) => r.token === `x_summarize-${OTHER}`)?.at).toEqual(at(-3));
  });

  test('while another batch of the session holds its lock, a batch answers 429 at once and writes nothing; it lands after the release', async () => {
    // OTHER: its own log, so the manifest of SESSION stays exact.
    const busy = batch({ puts: [{ rev: REV + 900, message: message('msg_busy', 0) }], threads: [thread('main')] });
    const busyRow = () =>
      db.select({ rev: sessionLogMessages.rev }).from(sessionLogMessages)
        .where(and(eq(sessionLogMessages.sessionId, OTHER), eq(sessionLogMessages.messageId, 'msg_busy')))
        .then((rows) => rows[0]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    // A slow batch of the same session: it holds `session-log:<session>` until released.
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`session-log:${OTHER}`}))`);
      locked();
      await held;
    });
    await lockTaken;
    const started = Date.now();
    const res = await journal(busy, tokens[OTHER]!, OTHER);
    const waited = Date.now() - started;
    release();
    await holder;
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('2');
    expect(waited).toBeLessThan(5_000);
    expect(await busyRow()).toBeUndefined();
    const retry = await journal(busy, tokens[OTHER]!, OTHER);
    expect(retry.status).toBe(200);
    expect((await busyRow())?.rev).toBe(REV + 900);
  });

  test('bodies: invalid JSON shape 400, over 2 MB gzipped 413, over 16 MB raw 413', async () => {
    expect((await journal(batch({ puts: [{ rev: -1, message: {} }] }))).status).toBe(400);
    expect((await journal(new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await journal(Bun.gzipSync(new Uint8Array(17 * 1024 * 1024)))).status).toBe(413);
  });
});

describe('credential', () => {
  test('a user token, or another session sandbox credential, answers 403', async () => {
    expect((await journal(first, ownerToken)).status).toBe(403);
    expect((await journal(first, tokens[OTHER]!)).status).toBe(403);
    expect((await manifest(tokens[OTHER]!)).status).toBe(403);
  });
});

describe('manifest', () => {
  test('lists the generation and every message with its rev as a JSON number and its tombstone', async () => {
    const res = await manifest();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generation: number; messages: Array<{ message_id: string; rev: unknown; deleted: boolean; content_hash: string }> };
    expect(body.generation).toBe(2);
    expect(body.messages.map((m) => [m.message_id, m.rev, m.deleted])).toEqual([
      ['msg_u1', REV + 10, false],
      ['msg_a1', REV + 20, true],
      ['msg_u2', REV + 11, false],
      ['msg_u3', REV + 40, false],
      ['msg_bin', REV + 60, false],
    ]);
    expect(body.messages[0]!.content_hash).toBe((await stored('msg_u1'))!.hash);
  });
});

describe('operator switch', () => {
  test('SESSION_LOG_INGEST_ENABLED=false answers 503 on both routes and writes nothing', async () => {
    config.SESSION_LOG_INGEST_ENABLED = false;
    try {
      expect((await journal(batch({ generation: 2, puts: [{ rev: REV + 60, message: message('msg_off', 6) }] }))).status).toBe(503);
      expect((await manifest()).status).toBe(503);
      expect(await stored('msg_off')).toBeUndefined();
    } finally {
      config.SESSION_LOG_INGEST_ENABLED = true;
    }
  });
});

test('RLS stays on with no policy on the four session-log tables', async () => {
  const rows = (await db.execute(sql`
    SELECT c.relname AS name, c.relrowsecurity AS rls,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'kortix' AND p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'kortix' AND c.relkind = 'r' AND c.relname LIKE 'session_log%' ORDER BY 1`)) as unknown as Array<{ name: string; rls: boolean; policies: number }>;
  expect(rows).toEqual(
    ['session_log_blobs', 'session_log_messages', 'session_log_threads', 'session_logs'].map((name) => ({ name, rls: true, policies: 0 })),
  );
});
