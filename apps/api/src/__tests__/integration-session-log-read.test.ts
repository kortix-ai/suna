/**
 * Integration test (real PostgreSQL, fresh migrated database, real routes): the
 * reads over the session log (P4.2, P8.2).
 *
 * One synthetic OpenCode session is stored two ways: as an old session's v1 mirror
 * rows only (seeded: nothing writes them since P8.2), and as the journal ingest of
 * `fromV1` of those same rows under producer `opencode`, as the daemon's adapter
 * journals them. The first read of the mirror-only session converts it into the
 * log (`convertMirrorOnRead`); from then on every v1 read (`transcript?shape=sync`
 * paged to the end, the child read, `shape=compact`, the open bundle, the public
 * share) answers it with the same body as the journaled one, apart from
 * `captured_at`. No read serves the mirror: the reads pass with both mirror tables
 * renamed away, a native (pi) thread is served through `toV1`, a drained mirror is
 * never read, and a mirror over the size cap answers 503 `session_log_converting`.
 * One tool output is 150,000 three-byte characters (450 kB): the log stores it by
 * reference (F3, P2.3), and the v1 reads put it back. The Storage bucket is
 * `helpers/fake-session-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { fromV1, toV1, type SessionLog, type SessionLogJournalRequest, type V1Row } from '@kortix/api-contract/session-log';
import { accountMembers, projectMembers, projectSessions, projects, sessionLogBackfillState, sessionLogs, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { seedV1Mirror } from './helpers/seed-v1-mirror';
import { syntheticOpencodeSession } from './helpers/synthetic-opencode-session';

const bucket = fakeSessionStorage();
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ storage: bucket.storage }) }));

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { mirrorRowsFromOpencodePayload } = await import('../projects/lib/session-transcript-mirror');
const { config } = await import('../config');
const { ingestSessionLogJournal } = await import('../projects/session-log-ingest');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_logreadroot000000000001';
const CHILD = 'ses_logreadchild00000000001';
const REV = 1_791_681_474_704_000;
/** Over 256 kB as UTF-8, under the mirror's 200,000-character cut. */
const WIDE_OUTPUT = '€'.repeat(150_000);

let project: SeededProject;
let session = '';
let mirrorSession = '';
let nativeSession = '';
let ownerToken = '';
let sandboxToken = '';
const shareTokens = new Map<string, string>();

const get = (path: string, token: string | null = ownerToken) =>
  app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const base = (sessionId = session) => `/v1/projects/${project.project_id}/sessions/${sessionId}`;
/** One synthetic session's root and child, with one bash output over 256 kB. */
function history(turns: number) {
  const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns });
  const bash = root.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.tool === 'bash' && (p.state as { status: string }).status === 'completed')!;
  (bash.state as { output: string }).output = WIDE_OUTPUT;
  return { root, child };
}

/** An old session: only its v1 mirror rows, no log. */
async function storeMirrorOnly(sessionId: string, turns: number) {
  const { root, child } = history(turns);
  await db.update(projectSessions).set({ runtimeSessionId: ROOT }).where(eq(projectSessions.sessionId, sessionId));
  await seedV1Mirror({ sessionId, projectId: project.project_id, accountId: project.account_id }, ROOT, root, [{ id: CHILD, payload: child }]);
}

/** Store one synthetic session in the log: the ingest of fromV1 of the rows a mirror would hold. */
async function storeInLog(sessionId: string, turns: number, options: { nativeThreads?: boolean } = {}) {
  const { root, child } = history(turns);
  await db.update(projectSessions).set({ runtimeSessionId: ROOT }).where(eq(projectSessions.sessionId, sessionId));
  const rows = [
    ...mirrorRowsFromOpencodePayload(root).map((r) => ({ runtime_session_id: ROOT, ...r })),
    ...mirrorRowsFromOpencodePayload(child).map((r) => ({ runtime_session_id: CHILD, ...r })),
  ];
  const log = fromV1({ session_id: sessionId, root_id: ROOT, rows: rows as unknown as V1Row[] }, { harness: 'opencode' });
  const producer = { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1.0.0' };
  if (options.nativeThreads) for (const t of log.threads) delete t.ext;
  const { threads, ...patch } = log;
  const batch: SessionLogJournalRequest = {
    generation: 0,
    session: patch,
    threads: threads.map(({ messages: _m, ...t }) => t),
    puts: threads.flatMap((t) => t.messages.map((m, i) => ({ rev: REV + i, message: { ...m, producer } }))),
    tombstones: [],
  };
  const outcome = await ingestSessionLogJournal({ sessionId, projectId: project.project_id, accountId: project.account_id }, batch);
  expect(outcome.status).toBe(200);
  // F3: the log row holds a preview and a reference; the object holds the output.
  const [offloaded] = await db.execute<{ n: number }>(sql`select count(*)::int as n from kortix.session_log_messages where session_id = ${sessionId} and record::text like '%kortix-attachment://%'`);
  expect(offloaded!.n).toBe(1);
  expect([...bucket.objects.keys()].filter((k) => k.startsWith(`${project.project_id}/${sessionId}/`))).toHaveLength(1);
  return { rows: rows.length, messages: batch.puts.length };
}

/** Every v1 read of the session, flag state as it is. `captured_at` is set aside and returned apart. */
async function v1Bodies(sessionId = session) {
  const captured: string[] = [];
  const strip = (body: Record<string, unknown>) => {
    captured.push(String(body.captured_at));
    const { captured_at: _c, ...rest } = body;
    return rest;
  };
  const pages: unknown[] = [];
  let cursor: string | null = null;
  do {
    const res = await get(`${base(sessionId)}/transcript?shape=sync&limit=40${cursor ? `&before=${cursor}` : ''}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    pages.push(strip(body));
    cursor = body.next_cursor as string | null;
  } while (cursor);
  const childRes = await get(`${base(sessionId)}/transcript?shape=sync&child=${CHILD}`);
  const compact = await get(`${base(sessionId)}/transcript?limit=60&chars=1500&detail=full`);
  const bundle = (await (await get(`${base(sessionId)}/open-bundle`)).json()) as Record<string, Record<string, unknown>>;
  const share = await get(`/v1/public/session-shares/${shareTokens.get(sessionId)}/messages`, null);
  expect(share.status).toBe(200);
  return {
    pages,
    child: strip((await childRes.json()) as Record<string, unknown>),
    compact: strip((await compact.json()) as Record<string, unknown>),
    bundle: strip(bundle.transcript!),
    bundleLog: bundle.log,
    share: strip((await share.json()) as Record<string, unknown>),
    captured,
  };
}

beforeAll(async () => {
  project = await seedProject('session-log-read');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  session = await seedSession(project, OWNER);
  mirrorSession = await seedSession(project, OWNER);
  nativeSession = await seedSession(project, OWNER);
  ownerToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'session-log-read-owner' })).secretKey;
  await db.insert(sessionSandboxes).values({ sandboxId: session, sessionId: session, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
  sandboxToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, projectId: project.project_id, sessionId: session, name: 'session-log-read-box' })).secretKey;
});

afterAll(async () => {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, project.account_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
  await db.execute(sql`delete from kortix.session_public_shares where session_id in (${session}, ${mirrorSession}, ${nativeSession})`).catch(() => undefined);
  await removeSeeded([project]);
});

/** A public share of `sessionId` with its transcript. */
async function share(sessionId: string) {
  const minted = await app.request(`${base(sessionId)}/public-shares`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: true }),
  });
  expect(minted.status).toBe(201);
  shareTokens.set(sessionId, ((await minted.json()) as { share: { public_token: string } }).share.public_token);
}

const logOf = (sessionId: string) => db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId));

describe('the v1 reads answer from the log; a mirror-only session is converted by its first read', () => {
  test('sync pages, the child, compact, the open bundle and the public share of a converted mirror equal the journaled log apart from captured_at', async () => {
    const stored = await storeInLog(session, 70);
    await storeMirrorOnly(mirrorSession, 70);
    await share(session);
    await share(mirrorSession);
    expect(await logOf(mirrorSession)).toHaveLength(0);

    const journaled = await v1Bodies(session);
    const converted = await v1Bodies(mirrorSession);
    // The first read wrote the log: `fromV1` of the mirror, no journal.
    const [log] = await logOf(mirrorSession);
    expect(log?.journalSeenAt).toBeNull();
    expect(['converted', 'partial']).toContain(log!.restoreGrade);

    expect(journaled.pages.length).toBe(4); // 140+ messages in windows of 40
    expect((journaled.pages[0] as { total: number }).total).toBe(stored.messages - 1); // the root read leaves out the child's 2 messages; a compaction summary is a second row
    expect(converted.pages).toEqual(journaled.pages);
    expect(JSON.stringify(converted.pages)).toContain(WIDE_OUTPUT);
    expect(converted.child).toEqual(journaled.child);
    expect((converted.child as { message_count: number }).message_count).toBe(2);
    expect(converted.compact).toEqual(journaled.compact);
    expect(converted.bundle).toEqual(journaled.bundle);
    expect(converted.share).toEqual(journaled.share);
    expect((converted.share as { message_count: number }).message_count).toBeGreaterThan(0);

    // captured_at is the log's last write.
    const [written] = await db.select({ updatedAt: sql<Date>`greatest(${sessionLogs.updatedAt}, (select max(m.updated_at) from kortix.session_log_messages m where m.session_id = ${session}))` }).from(sessionLogs).where(eq(sessionLogs.sessionId, session));
    expect(new Set(journaled.captured)).toEqual(new Set([new Date(written!.updatedAt).toISOString()]));

    // The open bundle's log leg: the first page of the root thread.
    const leg = journaled.bundleLog as { known: boolean; page: { thread_id: string; messages: Array<{ seq: number }>; has_more: boolean } };
    expect(leg.known).toBe(true);
    expect(leg.page.thread_id).toBe(ROOT);
    expect(leg.page.messages).toHaveLength(40);
    expect(leg.page.has_more).toBe(true);
  });

  test('a tombstoned message leaves the v1 read', async () => {
    const page = (await (await get(`${base()}/transcript?shape=sync&limit=5`)).json()) as { messages: Array<{ info: { id: string } }>; total: number };
    const victim = page.messages[0]!.info.id;
    const outcome = await ingestSessionLogJournal(
      { sessionId: session, projectId: project.project_id, accountId: project.account_id },
      { generation: 0, puts: [], threads: [], tombstones: [{ message_id: victim, rev: REV + 10_000 }] },
    );
    expect(outcome.status).toBe(200);
    const after = (await (await get(`${base()}/transcript?shape=sync&limit=5`)).json()) as typeof page;
    expect(after.messages.map((m) => m.info.id)).not.toContain(victim);
    expect(after.total).toBe(page.total - 1);
  });

  test('an unknown cursor answers 400', async () => {
    expect((await get(`${base()}/transcript?shape=sync&before=msg_nope`)).status).toBe(400);
  });

  test('a session whose threads fromV1 did not build (the pi adapter writes them natively) is served from the log through toV1', async () => {
    await storeInLog(nativeSession, 6, { nativeThreads: true });
    type Window = { available: boolean; captured_at: string; total: number; message_count: number; runtime_session_id: string; messages: Array<{ info: { id: string; role: string; sessionID: string } }> };
    const body = (await (await get(`${base(nativeSession)}/transcript?shape=sync`)).json()) as Window;
    const [log] = await db.select({ updatedAt: sql<Date>`greatest(${sessionLogs.updatedAt}, (select max(m.updated_at) from kortix.session_log_messages m where m.session_id = ${nativeSession}))` }).from(sessionLogs).where(eq(sessionLogs.sessionId, nativeSession));
    expect(body.available).toBe(true);
    expect(body.captured_at).toBe(new Date(log!.updatedAt).toISOString());
    expect(body.runtime_session_id).toBe(ROOT);
    // The rows the SDK renders for the native root thread: `toV1` of its stored records.
    const page = (await (await get(`${base(nativeSession)}/log?limit=500`)).json()) as { session: object; threads: Array<{ thread_id: string }>; messages: unknown[] };
    const thread = page.threads.find((t) => t.thread_id === ROOT)!;
    const expected = toV1({ ...page.session, session_id: nativeSession, threads: [{ ...thread, messages: page.messages }] } as unknown as SessionLog).rows;
    expect(body.total).toBe(expected.length);
    expect(body.messages.map((m) => [m.info.id, m.info.role, m.info.sessionID])).toEqual(
      expected.slice(-40).map((r) => [String((r.info as { id: string }).id), String((r.info as { role: string }).role), ROOT]),
    );
    const child = (await (await get(`${base(nativeSession)}/transcript?shape=sync&child=${CHILD}`)).json()) as Window;
    expect(child.available).toBe(true);
    expect(child.message_count).toBe(2);
    expect(child.messages.every((m) => m.info.sessionID === CHILD)).toBe(true);
  });

  test('a mirror over the size cap is not converted on a read: GET …/log answers 503 session_log_converting, the v1 read nothing saved', async () => {
    const big = await seedSession(project, OWNER);
    await storeMirrorOnly(big, 2);
    const cap = config.SESSION_LOG_RESTORE_MAX_BYTES;
    config.SESSION_LOG_RESTORE_MAX_BYTES = 2_000;
    try {
      const res = await get(`${base(big)}/log`);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(await res.json()).toMatchObject({ code: 'session_log_converting' });
      const sync = (await (await get(`${base(big)}/transcript?shape=sync`)).json()) as Record<string, unknown>;
      expect(sync).toMatchObject({ available: false, source: 'none' });
      expect(await logOf(big)).toHaveLength(0);
    } finally {
      config.SESSION_LOG_RESTORE_MAX_BYTES = cap;
    }
    // Under the cap (the backfill's thread, here the read again): converted and served.
    expect((await get(`${base(big)}/log`)).status).toBe(200);
  });

  test('a drained mirror is never read: a session without a log answers nothing saved and the mirror stays unread', async () => {
    const late = await seedSession(project, OWNER);
    await storeMirrorOnly(late, 2);
    await db.insert(sessionLogBackfillState).values({ id: 'pass', state: { drainedWithDeleted: true }, rev: 1 })
      .onConflictDoUpdate({ target: sessionLogBackfillState.id, set: { state: sql`jsonb_set(${sessionLogBackfillState.state}, '{drainedWithDeleted}', 'true')` } });
    try {
      expect((await get(`${base(late)}/log`)).status).toBe(404);
      const sync = (await (await get(`${base(late)}/transcript?shape=sync`)).json()) as Record<string, unknown>;
      expect(sync).toMatchObject({ available: false, source: 'none' });
      expect(await logOf(late)).toHaveLength(0);
    } finally {
      await db.delete(sessionLogBackfillState).where(eq(sessionLogBackfillState.id, 'pass'));
    }
    expect((await get(`${base(late)}/log`)).status).toBe(200);
  });

  test('every v1 read answers the same body with both mirror tables renamed away', async () => {
    const visible = await v1Bodies();
    await db.execute(sql`ALTER TABLE kortix.session_transcript_mirrors RENAME TO session_transcript_mirrors_hidden`);
    await db.execute(sql`ALTER TABLE kortix.session_transcript_messages RENAME TO session_transcript_messages_hidden`);
    try {
      const hidden = await v1Bodies();
      expect(hidden.pages).toEqual(visible.pages);
      expect(hidden.child).toEqual(visible.child);
      expect(hidden.compact).toEqual(visible.compact);
      expect(hidden.bundle).toEqual(visible.bundle);
      expect(hidden.share).toEqual(visible.share);
    } finally {
      await db.execute(sql`ALTER TABLE kortix.session_transcript_messages_hidden RENAME TO session_transcript_messages`);
      await db.execute(sql`ALTER TABLE kortix.session_transcript_mirrors_hidden RENAME TO session_transcript_mirrors`);
    }
  });
});

describe('GET .../log', () => {
  type Page = { session: { session_id?: string }; generation: number; threads: Array<{ thread_id: string }>; thread_id: string; messages: Array<{ seq: number; message_id: string }>; has_more: boolean };

  test('pages the root thread backwards by seq, ascending within a page, without the tombstoned message', async () => {
    const all: number[] = [];
    let before: number | null = null;
    let first: Page | null = null;
    for (;;) {
      const res = await get(`${base()}/log?limit=50${before === null ? '' : `&before_seq=${before}`}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page;
      first ??= page;
      const seqs = page.messages.map((m) => m.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      all.unshift(...seqs);
      if (!page.has_more) break;
      before = seqs[0]!;
    }
    expect(first!.session.session_id).toBe(session);
    expect(first!.generation).toBe(0);
    expect(first!.threads.map((t) => t.thread_id).sort()).toEqual([CHILD, ROOT].sort());
    expect(first!.thread_id).toBe(ROOT);
    expect(new Set(all).size).toBe(all.length);
    // One seq is a gap: the message tombstoned above.
    expect(all.length).toBe(all.at(-1)! - all[0]! );
  });

  test('thread= reads the child thread', async () => {
    const res = await get(`${base()}/log?thread=${CHILD}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page.thread_id).toBe(CHILD);
    expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(page.has_more).toBe(false);
  });

  test('a session-bound token reads the log wherever the v1 transcript route serves it, and nowhere else', async () => {
    const other = await seedProject('session-log-read-other', { accountId: project.account_id });
    const otherSession = await seedSession(other, OWNER);
    try {
      const statuses = async (path: string) => [
        (await get(`${path}/transcript?shape=sync`, sandboxToken)).status,
        (await get(`${path}/log`, sandboxToken)).status,
      ];
      // (a) its own session, (b) a sibling session of its project, (c) a session of another project.
      expect(await statuses(base())).toEqual([200, 200]);
      expect(await statuses(base(nativeSession))).toEqual([200, 200]);
      expect(await statuses(`/v1/projects/${other.project_id}/sessions/${otherSession}`)).toEqual([403, 403]);
      const own = (await (await get(`${base()}/log?limit=500`, sandboxToken)).json()) as Page;
      const owner = (await (await get(`${base()}/log?limit=500`)).json()) as Page;
      expect(own).toEqual(owner);
    } finally {
      await db.delete(projects).where(eq(projects.projectId, other.project_id));
    }
  });

  test('a KaaB backend-origin sibling and another user\'s private session: the log refuses them where the transcript does', async () => {
    const MEMBER = crypto.randomUUID();
    await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: project.account_id, accountRole: 'member' });
    await insertIntoView(db, projectMembers, { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' });
    // Two KaaB sessions: one wrapper credential (OWNER) created both, each box acts for one end-user.
    const [backendA, backendB, memberSession] = [await seedSession(project, OWNER), await seedSession(project, OWNER), await seedSession(project, MEMBER)];
    await db.update(projectSessions).set({ origin: 'backend' }).where(sql`${projectSessions.sessionId} in (${backendA}, ${backendB})`);
    for (const id of [backendA, backendB, memberSession]) await storeInLog(id, 6);
    // `session` is OWNER's private session (the column default): a log is stored, so a 404 below is the gate, not a missing log.
    const [row] = await db.select({ visibility: projectSessions.visibility }).from(projectSessions).where(eq(projectSessions.sessionId, session));
    expect(row!.visibility).toBe('private');
    const boxToken = async (sessionId: string, userId: string) => {
      await db.insert(sessionSandboxes).values({ sandboxId: sessionId, sessionId, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
      return (await createAccountToken({ accountId: project.account_id, userId, projectId: project.project_id, sessionId, name: `session-log-read-${sessionId}` })).secretKey;
    };
    const backendBox = await boxToken(backendA, OWNER);
    const memberBox = await boxToken(memberSession, MEMBER);
    const memberToken = (await createAccountToken({ accountId: project.account_id, userId: MEMBER, name: 'session-log-read-member' })).secretKey;
    const statuses = async (sessionId: string, token: string) => [
      (await get(`${base(sessionId)}/transcript?shape=sync`, token)).status,
      (await get(`${base(sessionId)}/log`, token)).status,
    ];
    // The backend box reads its own session, never its sibling; the signed-in human reads both.
    expect(await statuses(backendA, backendBox)).toEqual([200, 200]);
    expect(await statuses(backendB, backendBox)).toEqual([404, 404]);
    expect(await statuses(backendB, ownerToken)).toEqual([200, 200]);
    // Another user's private session: refused to the member and to the member's box; the owner reads it.
    expect(await statuses(session, memberToken)).toEqual([404, 404]);
    expect(await statuses(session, memberBox)).toEqual([404, 404]);
    expect(await statuses(memberSession, memberBox)).toEqual([200, 200]);
    expect(await statuses(session, ownerToken)).toEqual([200, 200]);
  });

  test('refuses a bad before_seq and limit; 404 for an unknown thread and without a log', async () => {
    expect((await get(`${base()}/log?before_seq=1.5`)).status).toBe(400);
    expect((await get(`${base()}/log?limit=501`)).status).toBe(400);
    expect((await get(`${base()}/log?thread=ses_not_a_thread`)).status).toBe(404);
    const empty = await seedSession(project, OWNER);
    expect((await get(`${base(empty)}/log`)).status).toBe(404);
    expect((await get(`${base()}/log`, null)).status).toBe(401);
  });
});

test('inventory reports the durable project-default turn model instead of the creation pin', async () => {
  const id = await seedSession(project, OWNER);
  await storeInLog(id, 1);
  await db.update(projectSessions).set({ metadata: { opencode_model: 'kortix/deepseek-v4.1-flash', opencode_model_source: 'platform' } }).where(eq(projectSessions.sessionId, id));
  await db.update(sessionLogs).set({ record: sql`jsonb_set(${sessionLogs.record}, '{selection}', ${JSON.stringify({ agent: null, model: { provider: 'kortix', model: 'glm-5.3-flash' } })}::jsonb)` }).where(eq(sessionLogs.sessionId, id));
  const response = await get(`/v1/projects/${project.project_id}/sessions`);
  expect(response.status).toBe(200);
  const rows: Array<{ session_id: string; model: string | null; metadata: Record<string, unknown> }> = await response.json();
  for (const path of [`/v1/projects/${project.project_id}/sessions/${id}`, `/v1/sessions/${id}`]) {
    const detail = await get(path);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ model: 'kortix/glm-5.3-flash' });
  }
  for (const route of ['snapshot', 'open-bundle']) {
    for (const transcript of [0, 40]) {
      const bundle = await get(`${base(id)}/${route}?transcript=${transcript}`);
      expect(bundle.status).toBe(200);
      expect(await bundle.json()).toMatchObject({
        session: { model: 'kortix/glm-5.3-flash', metadata: { opencode_model: 'kortix/deepseek-v4.1-flash' } },
      });
    }
  }
  expect(rows.find((row) => row.session_id === id)).toMatchObject({
    model: 'kortix/glm-5.3-flash',
    metadata: { opencode_model: 'kortix/deepseek-v4.1-flash' },
  });
});
