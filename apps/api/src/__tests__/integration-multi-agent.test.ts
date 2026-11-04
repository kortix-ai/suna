/**
 * Integration test (real local PostgreSQL): the multi-agent writes the API
 * owns (`@kortix/api-contract/multi-agent`).
 *
 *  - Notices into one session coalesce into ONE waiting row
 *    (`session-notice-batch.ts`): five finished agents, one wake-up.
 *  - A cross-session message to a session with no box is stored and its
 *    durable delivery row is queued: the send never waits for, or fails on,
 *    a dead receiver (`peer-messages/service.ts`).
 *  - A hold waits for approval; `notify_when_idle` sends one idle notice.
 *  - A team task claim is one compare-and-set: two parallel claims, one winner
 *    (`team-tasks/service.ts`); a blocked task cannot be claimed until its
 *    blocker completes.
 *
 * Real: every row and every SQL guard. Stubbed: the drain kick (delivery is
 * the lifecycle engine's own contract) and the person's prompt rights
 * (`mayPromptSessions`; the REST flows MSG-* prove the real check).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realAccess from '../notifications/access';
import * as realDrain from '../projects/session-lifecycle/drain';

mock.module('../projects/session-lifecycle/drain', () => ({
  ...realDrain,
  drainSessionLifecycleQueue: async () => undefined,
}));
let promptable = true;
mock.module('../notifications/access', () => ({
  ...realAccess,
  mayPromptSessions: async (_userId: string, _accountId: string, ids: readonly string[]) => new Set(promptable ? ids : []),
  maySeeSessions: async (_userId: string, rows: readonly { sessionId: string }[]) => new Set(rows.map((row) => row.sessionId)),
}));

const { db } = await import('../shared/db');
const { enqueueSessionNotice, NOTICE_BATCH_MAX, setNoticeBatchHoldForTests } = await import('../projects/session-notice-batch');
const { decideHeldMessage, firePeerIdleNotices, reachableAgents, sendPeerMessage } = await import('../projects/peer-messages/service');
const { createTask, deleteTask, listTasks, updateTask, TeamTaskError } = await import('../projects/team-tasks/service');

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const PERSON = crypto.randomUUID();
const LEAD = crypto.randomUUID();
const actor = { userId: PERSON, accountId: ACCOUNT_ID, credential: { kind: 'jwt' as const }, ctx: {} };
const caller = { actor, userId: PERSON, agentMayPrompt: true };

type CommandRow = { command_id: string; source: string; status: string; idempotency_key: string; actor_user_id: string | null; available_at: Date; payload: Record<string, any> };

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return ((result as { rows?: unknown[] }).rows ?? result) as T[];
}

async function insertSession(sessionId: string, opts: { parent?: string; metadata?: Record<string, unknown>; agent?: string } = {}) {
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status, created_by, agent_name, parent_session_id, metadata)
    VALUES (${sessionId}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${sessionId}`}, 'stopped', ${PERSON}::uuid, ${opts.agent ?? 'default'},
      ${opts.parent ?? null}, ${JSON.stringify(opts.metadata ?? {})}::jsonb)`);
}

async function session(sessionId: string) {
  const { projectSessions } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId));
  return row!;
}

const commandsOf = (sessionId: string) => rows<CommandRow>(sql`
  SELECT command_id, source, status, idempotency_key, actor_user_id, available_at, payload FROM kortix.session_lifecycle_commands
  WHERE session_id = ${sessionId} AND command_type = 'continue_session' ORDER BY created_at`);

beforeAll(async () => {
  setNoticeBatchHoldForTests(60_000);
  await db.execute(sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'multi-agent-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'multi-agent-it', 'https://example.invalid/r.git')`);
});

beforeEach(async () => {
  promptable = true;
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE project_id = ${PROJECT_ID}::uuid`);
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE project_id = ${PROJECT_ID}::uuid`);
  await insertSession(LEAD, { agent: 'my-kortix' });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE project_id = ${PROJECT_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE project_id = ${PROJECT_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`).catch(() => undefined);
});

const notice = (key: string, text: string) => ({
  source: 'system:subagent-finished' as const, projectId: PROJECT_ID, accountId: ACCOUNT_ID, sessionId: LEAD,
  actorUserId: PERSON, text, key,
});

describe('notices into one session', () => {
  test('five notices that arrive together are one waiting row, held before its first delivery; a repeat key adds nothing', async () => {
    const before = Date.now();
    const results = [];
    for (let i = 1; i <= 5; i += 1) results.push(await enqueueSessionNotice(notice(`n:${i}`, `notice ${i}`)));
    expect(results.map((r) => r.coalesced)).toEqual([false, true, true, true, true]);
    expect(await enqueueSessionNotice(notice('n:3', 'notice 3 again'))).toMatchObject({ deduped: true });
    const [row, ...rest] = await commandsOf(LEAD);
    expect(rest).toHaveLength(0);
    expect(row!.status).toBe('queued');
    expect(row!.idempotency_key).toBe('n:1');
    expect(row!.payload).toMatchObject({ noticeBatch: true, delivery: 'steer', placement: 'composer', clientMessageId: 'n:1' });
    expect(row!.payload.noticeKeys).toEqual(['n:1', 'n:2', 'n:3', 'n:4', 'n:5']);
    expect(row!.payload.text).toBe('notice 1\n\nnotice 2\n\nnotice 3\n\nnotice 4\n\nnotice 5');
    expect(row!.payload.parts).toEqual([{ type: 'text', text: row!.payload.text, synthetic: true }]);
    expect(new Date(row!.available_at).getTime()).toBeGreaterThan(before);
  });

  test('five notices racing in parallel are still one row', async () => {
    await Promise.all([1, 2, 3, 4, 5].map((i) => enqueueSessionNotice(notice(`p:${i}`, `parallel ${i}`))));
    const all = await commandsOf(LEAD);
    expect(all).toHaveLength(1);
    expect([...all[0]!.payload.noticeKeys].sort()).toEqual(['p:1', 'p:2', 'p:3', 'p:4', 'p:5']);
  });

  test('a notice after the row was claimed, or past the batch cap, starts the next row', async () => {
    await enqueueSessionNotice(notice('c:1', 'first'));
    await db.execute(sql`UPDATE kortix.session_lifecycle_commands SET status = 'running' WHERE idempotency_key = 'c:1'`);
    await enqueueSessionNotice(notice('c:2', 'second'));
    for (let i = 3; i < 3 + NOTICE_BATCH_MAX; i += 1) await enqueueSessionNotice(notice(`c:${i}`, `n${i}`));
    const all = await commandsOf(LEAD);
    expect(all.map((r) => r.idempotency_key)).toEqual(['c:1', 'c:2', `c:${2 + NOTICE_BATCH_MAX}`]);
    expect(all[1]!.payload.noticeKeys).toHaveLength(NOTICE_BATCH_MAX);
  });

  test('another acting person never joins the row: a running turn takes a steer only from its prompter', async () => {
    await enqueueSessionNotice(notice('a:1', 'mine'));
    await enqueueSessionNotice({ ...notice('a:2', 'theirs'), actorUserId: crypto.randomUUID() });
    expect((await commandsOf(LEAD)).map((r) => r.idempotency_key)).toEqual(['a:1', 'a:2']);
  });
});

describe('cross-session messages', () => {
  test('a message to a session with no box is delivered as a durable queued row, and the send returns at once', async () => {
    const reviewer = crypto.randomUUID();
    await insertSession(reviewer, { parent: LEAD, metadata: { agent_handle: 'reviewer', spawned_by_session: LEAD } });
    const started = Date.now();
    const outcome = await sendPeerMessage({ sender: await session(LEAD), body: { to: 'reviewer', message: 'Check PR 12', summary: 'review' }, caller });
    expect(Date.now() - started).toBeLessThan(1_000);
    if (outcome.kind !== 'result') throw new Error('ambiguous');
    expect(outcome.result).toMatchObject({ status: 'delivered', to: { handle: 'reviewer', relation: 'child', can_receive: true } });
    const [row] = await commandsOf(reviewer);
    expect(row).toMatchObject({ source: 'system:peer-message', status: 'queued', actor_user_id: PERSON });
    expect(row!.idempotency_key).toBe(`peer:${outcome.result.message!.id}`);
    expect(row!.payload).toMatchObject({ delivery: 'steer', authorSessionId: LEAD });
    expect(row!.payload.text).toStartWith(`[message from my-kortix-${LEAD.slice(0, 8)} · session ${LEAD.slice(0, 8)} · #${outcome.result.message!.id} · review]\n\nCheck PR 12\n`);

    // The same text again within a minute is dropped, not sent twice.
    const again = await sendPeerMessage({ sender: await session(LEAD), body: { to: 'reviewer', message: 'Check PR 12' }, caller });
    expect(again).toMatchObject({ kind: 'result', result: { status: 'dropped', message: null } });
    expect(await commandsOf(reviewer)).toHaveLength(1);
  });

  test('two sessions with one handle answer ambiguous; parent and main resolve; a person who may not prompt is refused', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await insertSession(a, { metadata: { agent_handle: 'writer' } });
    await insertSession(b, { metadata: { agent_handle: 'writer' } });
    const ambiguous = await sendPeerMessage({ sender: await session(LEAD), body: { to: '@writer', message: 'hi' }, caller });
    expect(ambiguous.kind).toBe('ambiguous');
    if (ambiguous.kind === 'ambiguous') expect(ambiguous.candidates.map((c) => c.session_id).sort()).toEqual([a, b].sort());

    const child = crypto.randomUUID();
    await insertSession(child, { parent: LEAD, metadata: { team_lead: LEAD, agent_handle: 'tester', spawned_by_session: LEAD } });
    for (const to of ['parent', 'main']) {
      const sent = await sendPeerMessage({ sender: await session(child), body: { to, message: `to ${to}` }, caller });
      expect(sent).toMatchObject({ kind: 'result', result: { status: 'delivered', to: { session_id: LEAD, relation: 'lead' } } });
    }
    promptable = false;
    const refused = await sendPeerMessage({ sender: await session(child), body: { to: 'main', message: 'not allowed' }, caller });
    expect(refused).toMatchObject({ kind: 'result', result: { status: 'refused' } });
    if (refused.kind === 'result') expect(refused.result.note).toStartWith('Not sent: ');

    const reach = await reachableAgents({ self: await session(child), scope: 'mine', caller: { ...caller } });
    expect(reach.self).toMatchObject({ relation: 'self', handle: 'tester', can_receive: false });
    expect(reach.agents.map((x) => x.relation)).toEqual(['lead']);
  });

  test('a hold waits for the person: approve delivers once, a second decision is refused; refuse never delivers', async () => {
    const quiet = crypto.randomUUID();
    await insertSession(quiet, { metadata: { agent_handle: 'quiet', inbound: 'hold' } });
    const held = await sendPeerMessage({ sender: await session(LEAD), body: { to: 'quiet', message: 'may I?', notify_when_idle: true }, caller });
    if (held.kind !== 'result') throw new Error('ambiguous');
    expect(held.result.status).toBe('held');
    expect(await commandsOf(quiet)).toHaveLength(0);
    const approved = await decideHeldMessage({ receiver: await session(quiet), messageId: held.result.message!.id, approve: true });
    expect(approved.status).toBe('delivered');
    expect(await commandsOf(quiet)).toHaveLength(1);
    await expect(decideHeldMessage({ receiver: await session(quiet), messageId: held.result.message!.id, approve: false })).rejects.toThrow();

    // A turn that ends before the message reached the box never read it: no notice yet.
    expect(await firePeerIdleNotices({ sessionId: quiet, outcome: 'idle', excerpt: 'Too early.' })).toBe(0);
    await db.execute(sql`UPDATE kortix.session_lifecycle_commands SET status = 'succeeded' WHERE session_id = ${quiet}`);
    // The turn that read it ends: the sender gets one idle notice, once.
    expect(await firePeerIdleNotices({ sessionId: quiet, outcome: 'idle', excerpt: 'Done.' })).toBe(1);
    expect(await firePeerIdleNotices({ sessionId: quiet, outcome: 'idle', excerpt: 'Done.' })).toBe(0);
    const [idle] = (await commandsOf(LEAD)).filter((r) => r.source === 'system:peer-message');
    expect(idle!.payload.text).toStartWith(`[idle notice from quiet · session ${quiet.slice(0, 8)} · #${held.result.message!.id}]\n\nquiet finished its turn and is idle.\n\nIts last answer: Done.`);

    await db.execute(sql`UPDATE kortix.project_sessions SET metadata = metadata || '{"inbound":"refuse"}' WHERE session_id = ${quiet}`);
    const refused = await sendPeerMessage({ sender: await session(LEAD), body: { to: 'quiet', message: 'and now?' }, caller });
    expect(refused).toMatchObject({ kind: 'result', result: { status: 'refused', note: 'Not sent: quiet refuses messages.' } });
    expect(await commandsOf(quiet)).toHaveLength(1);
  });
});

describe('team tasks', () => {
  const lead = async () => session(LEAD);
  const mate = (sessionId: string, handle: string) => ({ kind: 'session' as const, sessionId, handle, role: 'teammate' as const });

  test('two parallel claims of one task: one wins, the other gets task_taken', async () => {
    const [x, y] = [crypto.randomUUID(), crypto.randomUUID()];
    await insertSession(x, { parent: LEAD, metadata: { team_lead: LEAD, agent_handle: 'x' } });
    await insertSession(y, { parent: LEAD, metadata: { team_lead: LEAD, agent_handle: 'y' } });
    const task = await createTask({ lead: await lead(), body: { subject: 'Write the parser' }, createdBySessionId: LEAD });
    expect(task).toMatchObject({ seq: 1, status: 'pending', owner_handle: null, blocked: false });
    const results = await Promise.allSettled([
      updateTask({ lead: await lead(), seq: 1, body: { claim: true }, caller: mate(x, 'x') }),
      updateTask({ lead: await lead(), seq: 1, body: { claim: true }, caller: mate(y, 'y') }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(TeamTaskError);
    expect(lost[0]!.reason.code).toBe('task_taken');
    const [stored] = await listTasks(LEAD);
    expect(stored!.status).toBe('in_progress');
    expect(['x', 'y']).toContain(stored!.owner_handle ?? '');
  });

  test('a blocked task cannot be claimed until its blocker completes; deleting a blocker unblocks', async () => {
    const x = crypto.randomUUID();
    await insertSession(x, { parent: LEAD, metadata: { team_lead: LEAD, agent_handle: 'x' } });
    await createTask({ lead: await lead(), body: { subject: 'Schema' }, createdBySessionId: LEAD });
    const second = await createTask({ lead: await lead(), body: { subject: 'Routes', blocked_by: [1] }, createdBySessionId: LEAD });
    expect(second).toMatchObject({ seq: 2, blocked: true, blocked_by: [1] });
    await expect(updateTask({ lead: await lead(), seq: 2, body: { claim: true }, caller: mate(x, 'x') })).rejects.toMatchObject({ code: 'task_blocked' });
    await updateTask({ lead: await lead(), seq: 1, body: { status: 'completed' }, caller: mate(x, 'x') });
    expect((await listTasks(LEAD)).find((t) => t.seq === 2)!.blocked).toBe(false);
    expect(await updateTask({ lead: await lead(), seq: 2, body: { claim: true }, caller: mate(x, 'x') })).toMatchObject({ status: 'in_progress', owner_handle: 'x', owner_session_id: x });

    await createTask({ lead: await lead(), body: { subject: 'Docs', blocked_by: [2] }, createdBySessionId: LEAD });
    await deleteTask(LEAD, 2);
    expect((await listTasks(LEAD)).find((t) => t.seq === 3)).toMatchObject({ blocked_by: [], blocked: false });
    // A loop and an unknown teammate are refused.
    await createTask({ lead: await lead(), body: { subject: 'Review', blocked_by: [3] }, createdBySessionId: LEAD });
    await expect(updateTask({ lead: await lead(), seq: 3, body: { add_blocked_by: [4] }, caller: mate(x, 'x') })).rejects.toMatchObject({ code: 'task_blocked_loop' });
    await expect(createTask({ lead: await lead(), body: { subject: 'Ship', owner: 'nobody' }, createdBySessionId: LEAD })).rejects.toMatchObject({ code: 'unknown_teammate' });
  });

  test('parallel creates get distinct numbers', async () => {
    const created = await Promise.all([1, 2, 3, 4].map(async (i) => createTask({ lead: await lead(), body: { subject: `t${i}` }, createdBySessionId: LEAD })));
    expect(created.map((t) => t.seq).sort()).toEqual([1, 2, 3, 4]);
  });
});
