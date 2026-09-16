import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { accounts, projects, projectSessions, sessionSandboxes, sessionWorkerLog, sessionTurns } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { resumePiSandboxTurn } from '../projects/pi-turn-recovery';
import { completeSandboxTurn, turnCompletionAllowsQueuePromotion } from '../projects/sandbox-turn-lifecycle';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const oldToken = crypto.randomUUID();
const identity = { opencodeSessionId: 'ses_pi_fixture', messageId: 'msg_fixture', ownerId: crypto.randomUUID() };
const metadata = { sandbox_slug: 'pi-worker', pi_worker_boot: true, pi_worker_ref: 'main', pi_worker_sha: 'a'.repeat(40) };
const append = (record: Record<string, unknown>) => db.insert(sessionWorkerLog).values({
  sessionId, item: { kind: 'journal', stream: 'kortix.pi.turn-admission.v1', record },
});
const readTurns = () => db.select().from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId));
const readBox = async () => (await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)))[0]!;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'pi-recovery-fixture' });
  await db.insert(projects).values({ projectId, accountId, name: 'pi-recovery-fixture', repoUrl: 'https://example.test/recovery.git' });
  await db.insert(projectSessions).values({ sessionId, projectId, accountId, branchName: sessionId, metadata });
  await db.insert(sessionSandboxes).values({ sandboxId: sessionId, sessionId, projectId, accountId, status: 'active' });
});

beforeEach(async () => {
  await db.delete(sessionWorkerLog).where(eq(sessionWorkerLog.sessionId, sessionId));
  await db.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId));
  await db.update(projectSessions).set({ metadata }).where(eq(projectSessions.sessionId, sessionId));
  await db.update(sessionSandboxes).set({ status: 'active', metadata: {}, deadlineAt: new Date(Date.now() + 60_000) })
    .where(eq(sessionSandboxes.sandboxId, sessionId));
  await db.insert(sessionTurns).values({ turnToken: oldToken, sandboxId: sessionId, sessionId, projectId, accountId,
    opencodeSessionId: identity.opencodeSessionId, messageId: identity.messageId,
    state: 'ended', endReason: 'runtime_gone', endedAt: new Date() });
  await append({ type: 'accepted', turn: { messageId: identity.messageId, wireUserMessage: { info: { sessionID: identity.opencodeSessionId } } } });
  await append({ type: 'started', messageId: identity.messageId, ownerId: identity.ownerId });
});

afterAll(async () => {
  await db.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test('restores one active attempt and fences delayed completion from the old worker', async () => {
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('resumed');
  const turns = await readTurns();
  expect(turns).toHaveLength(2);
  expect(turns.find((turn) => turn.turnToken === oldToken)?.endReason).toBe('runtime_gone');
  expect(turns.filter((turn) => turn.state === 'active')).toHaveLength(1);
  const box = await readBox();
  expect(box.deadlineAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  expect(Object.values(box.metadata?.activeTurns as Record<string, unknown>)).toEqual([
    expect.objectContaining({ runtimeOwnerId: identity.ownerId, messageId: identity.messageId, state: 'active' }),
  ]);
  for (const owner of [null, crypto.randomUUID()]) {
    const stale = await completeSandboxTurn(sessionId, 'idle', identity, null, undefined, { runtimeOwnerId: owner });
    expect(stale.closedTurnCount).toBe(0);
    expect(stale.outcome).toBe('identity_mismatch');
    expect(turnCompletionAllowsQueuePromotion(stale)).toBe(false);
    expect((await readTurns()).filter((turn) => turn.state === 'active')).toHaveLength(1);
  }
  expect((await completeSandboxTurn(sessionId, 'idle', identity, null, undefined, { runtimeOwnerId: identity.ownerId })).closedTurnCount).toBe(1);
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('terminal');
  expect((await readTurns()).filter((turn) => turn.state === 'active')).toHaveLength(0);
});

test('concurrent resume acknowledgments create exactly one active attempt', async () => {
  expect((await Promise.all([resumePiSandboxTurn(sessionId, identity), resumePiSandboxTurn(sessionId, identity)])).sort())
    .toEqual(['already_active', 'resumed']);
  expect(await readTurns()).toHaveLength(2);
});

test('a later durable owner supersedes a resumed attempt without reviving the old owner', async () => {
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('resumed');
  const replacement = { ...identity, ownerId: crypto.randomUUID() };
  await append({ type: 'reclaimed', messageId: identity.messageId, ownerId: replacement.ownerId, previousOwnerId: identity.ownerId });
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('invalid_owner');
  expect(await resumePiSandboxTurn(sessionId, replacement)).toBe('resumed');
  expect((await readTurns()).filter((turn) => turn.state === 'active')).toHaveLength(1);
  expect((await completeSandboxTurn(sessionId, 'idle', identity, null, undefined, { runtimeOwnerId: identity.ownerId })).closedTurnCount).toBe(0);
  expect((await completeSandboxTurn(sessionId, 'idle', replacement, null, undefined, { runtimeOwnerId: replacement.ownerId })).closedTurnCount).toBe(1);
});

test.each(['completed', 'cancelled', 'abort_requested', 'abort_acknowledged'])('%s journal evidence prevents recovery', async (type) => {
  await append({ type, messageId: identity.messageId });
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('terminal');
  expect(await readTurns()).toHaveLength(1);
});

test('wrong owner, message, native session, and terminal ledger rows cannot gain authority', async () => {
  for (const changed of [{ ownerId: crypto.randomUUID() }, { messageId: 'msg_other' }, { opencodeSessionId: 'ses_other' }]) {
    expect(await resumePiSandboxTurn(sessionId, { ...identity, ...changed })).toBe('invalid_owner');
  }
  await db.update(sessionTurns).set({ endReason: 'completed' }).where(eq(sessionTurns.turnToken, oldToken));
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('terminal');
  expect(await readTurns()).toHaveLength(1);
});

test('another active turn, a stop claim, a stopped box, and OpenCode all refuse recovery', async () => {
  await db.update(sessionSandboxes).set({ metadata: { activeTurns: { other: { token: 'other', messageId: 'msg_other', opencodeSessionId: identity.opencodeSessionId, state: 'active' } } } })
    .where(eq(sessionSandboxes.sandboxId, sessionId));
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('busy');
  await db.update(sessionSandboxes).set({ metadata: { lifecycleStopClaim: { claimedAtMs: Date.now() } } })
    .where(eq(sessionSandboxes.sandboxId, sessionId));
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('unavailable');
  await db.update(sessionSandboxes).set({ metadata: {}, status: 'stopped' }).where(eq(sessionSandboxes.sandboxId, sessionId));
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('unavailable');
  await db.update(sessionSandboxes).set({ status: 'active' }).where(eq(sessionSandboxes.sandboxId, sessionId));
  await db.update(projectSessions).set({ metadata: {} }).where(eq(projectSessions.sessionId, sessionId));
  expect(await resumePiSandboxTurn(sessionId, identity)).toBe('unavailable');
  expect(await readTurns()).toHaveLength(1);
});
