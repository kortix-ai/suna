/**
 * Integration test (real PostgreSQL, fresh migrated database, real routes): the
 * reads over the session log (P4.2).
 *
 * One synthetic OpenCode session is stored two ways: the transcript capture
 * writes the v1 mirror rows, and the journal ingest writes `fromV1` of those
 * same rows under producer `opencode`, as the daemon's adapter journals them.
 * Every v1 read (`transcript?shape=sync` paged to the end, the child read,
 * `shape=compact`, the open bundle, the public share) must answer the same body
 * with the project flag `session_log` off (the mirror) and on (the log). The one
 * field that differs is `captured_at`. One tool output is 150,000 three-byte
 * characters (450 kB): the mirror keeps it (under 200,000 characters), the log
 * stores it by reference (F3, P2.3), and the v1 reads put it back. The Storage
 * bucket is `helpers/fake-session-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { fromV1, type SessionLogJournalRequest, type V1Row } from '@kortix/api-contract/session-log';
import { accountMembers, projectMembers, projectSessions, projects, sessionLogs, sessionSandboxes, sessionTranscriptMessages, sessionTranscriptMirrors } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { syntheticOpencodeSession } from './helpers/synthetic-opencode-session';

const bucket = fakeSessionStorage();
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ storage: bucket.storage }) }));

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { captureSessionTranscriptMirror } = await import('../projects/lib/session-transcript-capture');
const { ingestSessionLogJournal } = await import('../projects/session-log-ingest');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_logreadroot000000000001';
const CHILD = 'ses_logreadchild00000000001';
const REV = 1_791_681_474_704_000;
/** Over 256 kB as UTF-8, under the mirror's 200,000-character cut. */
const WIDE_OUTPUT = '€'.repeat(150_000);

let project: SeededProject;
let session = '';
let nativeSession = '';
let ownerToken = '';
let sandboxToken = '';
let shareToken = '';

const get = (path: string, token: string | null = ownerToken) =>
  app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const base = (sessionId = session) => `/v1/projects/${project.project_id}/sessions/${sessionId}`;
const setFlag = (on: boolean) =>
  db.update(projects).set({ metadata: sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), '{experimental}', ${JSON.stringify({ session_log: on })}::jsonb)` }).where(eq(projects.projectId, project.project_id));

/** Store one synthetic session in the mirror (the capture) and in the log (the ingest of fromV1 of the same rows). */
async function storeBothWays(sessionId: string, turns: number, options: { nativeThreads?: boolean } = {}) {
  const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns });
  const bash = root.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.tool === 'bash' && (p.state as { status: string }).status === 'completed')!;
  (bash.state as { output: string }).output = WIDE_OUTPUT;
  await db.update(projectSessions).set({ runtimeSessionId: ROOT }).where(eq(projectSessions.sessionId, sessionId));
  const captured = await captureSessionTranscriptMirror(sessionId, {
    readMessages: async () => ({ opencodeSessionId: ROOT, payload: root, headComplete: true, complete: true, children: [{ opencodeSessionId: CHILD, payload: child, complete: true }] }),
  });
  expect(captured?.head_complete).toBe(true);
  const rows = await db
    .select({ runtime_session_id: sessionTranscriptMessages.runtimeSessionId, info: sessionTranscriptMessages.info, parts: sessionTranscriptMessages.parts })
    .from(sessionTranscriptMessages)
    .where(eq(sessionTranscriptMessages.sessionId, sessionId));
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
  const share = await get(`/v1/public/session-shares/${shareToken}/messages`, null);
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
  nativeSession = await seedSession(project, OWNER);
  ownerToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'session-log-read-owner' })).secretKey;
  await db.insert(sessionSandboxes).values({ sandboxId: session, sessionId: session, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
  sandboxToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, projectId: project.project_id, sessionId: session, name: 'session-log-read-box' })).secretKey;
  await setFlag(false);
});

afterAll(async () => {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, project.account_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
  await db.execute(sql`delete from kortix.session_public_shares where session_id in (${session}, ${nativeSession})`).catch(() => undefined);
  await removeSeeded([project]);
});

describe('the v1 reads answer the same body from the mirror (flag off) and from the log (flag on)', () => {
  test('sync pages, the child, compact, the open bundle and the public share are equal apart from captured_at', async () => {
    const stored = await storeBothWays(session, 70);
    // 70 turns: the compaction summary folds into its marker, so the log holds one message fewer than the mirror's rows.
    expect(stored.rows).toBe(stored.messages + 1);
    const minted = await app.request(`${base()}/public-shares`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: true }),
    });
    expect(minted.status).toBe(201);
    shareToken = ((await minted.json()) as { share: { public_token: string } }).share.public_token;

    const off = await v1Bodies();
    await setFlag(true);
    const on = await v1Bodies();

    expect(off.pages.length).toBe(4); // 140+ rows in windows of 40
    expect((off.pages[0] as { total: number }).total).toBe(stored.rows - 2); // the root read leaves out the child's 2 rows
    expect(on.pages).toEqual(off.pages);
    expect(JSON.stringify(on.pages)).toContain(WIDE_OUTPUT);
    expect(on.child).toEqual(off.child);
    expect((on.child as { message_count: number }).message_count).toBe(2);
    expect(on.compact).toEqual(off.compact);
    expect(on.bundle).toEqual(off.bundle);
    expect(on.share).toEqual(off.share);
    expect((on.share as { message_count: number }).message_count).toBeGreaterThan(0);

    // The field that differs: the log's last write, not the capture time.
    const [log] = await db.select({ updatedAt: sql<Date>`greatest(${sessionLogs.updatedAt}, (select max(m.updated_at) from kortix.session_log_messages m where m.session_id = ${session}))` }).from(sessionLogs).where(eq(sessionLogs.sessionId, session));
    const [mirror] = await db.select({ capturedAt: sessionTranscriptMirrors.capturedAt }).from(sessionTranscriptMirrors).where(eq(sessionTranscriptMirrors.sessionId, session));
    expect(new Set(on.captured)).toEqual(new Set([new Date(log!.updatedAt).toISOString()]));
    expect(new Set(off.captured)).toEqual(new Set([new Date(mirror!.capturedAt).toISOString()]));

    // The open bundle's log leg: absent with the flag off, the first page with it on.
    expect(off.bundleLog).toBeUndefined();
    const leg = on.bundleLog as { known: boolean; page: { thread_id: string; messages: Array<{ seq: number }>; has_more: boolean } };
    expect(leg.known).toBe(true);
    expect(leg.page.thread_id).toBe(ROOT);
    expect(leg.page.messages).toHaveLength(40);
    expect(leg.page.has_more).toBe(true);
  });

  test('with the flag on, a tombstoned message leaves the v1 read; the mirror still holds it', async () => {
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
    await setFlag(false);
    const mirror = (await (await get(`${base()}/transcript?shape=sync&limit=5`)).json()) as typeof page;
    expect(mirror.messages.map((m) => m.info.id)).toContain(victim);
    await setFlag(true);
  });

  test('an unknown cursor answers 400 from the log, as from the mirror', async () => {
    expect((await get(`${base()}/transcript?shape=sync&before=msg_nope`)).status).toBe(400);
  });

  test('a session whose threads fromV1 did not build (the pi adapter writes them natively) is served from the mirror', async () => {
    // The mirror is history from before the flag: with it on, the capture writes no v1 row (P8).
    await setFlag(false);
    await storeBothWays(nativeSession, 6, { nativeThreads: true });
    await setFlag(true);
    const body = (await (await get(`${base(nativeSession)}/transcript?shape=sync`)).json()) as { captured_at: string };
    const [mirror] = await db.select({ capturedAt: sessionTranscriptMirrors.capturedAt }).from(sessionTranscriptMirrors).where(eq(sessionTranscriptMirrors.sessionId, nativeSession));
    expect(body.captured_at).toBe(new Date(mirror!.capturedAt).toISOString());
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

  test('thread= reads the child thread; the flag does not gate the route', async () => {
    await setFlag(false);
    const res = await get(`${base()}/log?thread=${CHILD}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page.thread_id).toBe(CHILD);
    expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(page.has_more).toBe(false);
    await setFlag(true);
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
    for (const id of [backendA, backendB, memberSession]) await storeBothWays(id, 6);
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
