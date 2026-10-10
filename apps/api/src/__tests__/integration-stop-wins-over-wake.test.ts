/**
 * Integration test (real app + real PostgreSQL): a user Stop wins over a
 * `/start` long-poll that was already waiting when it landed.
 *
 * The web client long-polls `/start?wait_ms=15000` (no `keep_stopped`) while a
 * session boots. A Stop of an ephemeral box deletes it and leaves the row
 * stopped and retired. The long-poll's next tick used to claim that retired
 * row and allocate a fresh box about a second after the stop, and an open
 * during the stop answered for a box that was being deleted. Only an open
 * formed after the Stop may wake the session again.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountMembers, projectMembers, projectSessions, sessionSandboxes } from '@kortix/db';
import { app } from '../index';
import { db } from '../shared/db';
import { config } from '../config';
import { EPHEMERAL_RETIRED_KEY } from '../platform/services/ephemeral-sandbox';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import {
  localTestDatabaseUrl,
  removeSeeded,
  seedProject,
  seedSession,
  type SeededProject,
} from './helpers/integration-fixtures';

let project: SeededProject | null = null;
let userId = '';
let token = '';
const sessions: string[] = [];
let stubServer: ReturnType<typeof Bun.serve> | null = null;
const creates: string[] = [];
const savedConfig: Record<string, unknown> = {};

beforeAll(async () => {
  localTestDatabaseUrl();
  // The control plane records every create; nothing here is meant to boot.
  stubServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/v1/sandboxes') creates.push(url.pathname);
      return Response.json({ error: `no route ${url.pathname}` }, { status: 404 });
    },
  });
  for (const key of ['PLATINUM_API_URL', 'PLATINUM_API_KEY', 'ALLOWED_SANDBOX_PROVIDERS', 'KORTIX_URL'] as const) {
    savedConfig[key] = config[key];
  }
  config.PLATINUM_API_URL = `http://127.0.0.1:${stubServer.port}`;
  config.PLATINUM_API_KEY = 'pt_test_stop_wins';
  config.ALLOWED_SANDBOX_PROVIDERS = ['platinum'];
  (config as unknown as Record<string, unknown>).KORTIX_URL = 'https://api.stop-wins.example';

  project = await seedProject('stop-wins');
  userId = crypto.randomUUID();
  await insertIntoView(db, accountMembers, { accountId: project.account_id, userId, accountRole: 'owner' });
  await insertIntoView(db, projectMembers, {
    accountId: project.account_id,
    projectId: project.project_id,
    userId,
    projectRole: 'manager',
  });
  token = (await createAccountToken({ accountId: project.account_id, userId, name: 'stop-wins-pat' })).secretKey;
});

afterAll(async () => {
  // Let the explicit start's detached allocation settle against the stub.
  await Bun.sleep(500);
  for (const sessionId of sessions) {
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId));
  }
  if (project) await removeSeeded([project]);
  stubServer?.stop(true);
  for (const [key, value] of Object.entries(savedConfig)) {
    (config as unknown as Record<string, unknown>)[key] = value;
  }
});

async function session(sandbox: { status: 'provisioning' | 'active' | 'stopped'; externalId: string | null; metadata: Record<string, unknown> }) {
  const sessionId = await seedSession(project!, userId);
  sessions.push(sessionId);
  await db
    .update(projectSessions)
    .set({ agentName: 'main', sandboxProvider: 'platinum' })
    .where(eq(projectSessions.sessionId, sessionId));
  const sandboxId = crypto.randomUUID();
  await db.insert(sessionSandboxes).values({
    sandboxId,
    sessionId,
    accountId: project!.account_id,
    projectId: project!.project_id,
    provider: 'platinum',
    ...sandbox,
  });
  return { sessionId, sandboxId };
}

/** What `retireEphemeralOnStop` leaves behind after a user Stop. */
async function landStop(sandboxId: string, stoppedAt: Date, retiredBox = 'stop-wins-old-box') {
  await db
    .update(sessionSandboxes)
    .set({
      status: 'stopped',
      externalId: null,
      metadata: {
        stopReason: 'manual',
        stoppedAt: stoppedAt.toISOString(),
        [EPHEMERAL_RETIRED_KEY]: retiredBox,
        platinumCreateAttempt: 1,
      },
    })
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
}

async function start(sessionId: string, query = ''): Promise<{ stage?: string; reason?: string }> {
  const res = await app.request(`/v1/projects/${project!.project_id}/sessions/${sessionId}/start${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { stage?: string; reason?: string };
}

async function rowsOf(sessionId: string) {
  return db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId));
}

test('a long-poll already waiting when the Stop lands answers stopped and allocates nothing', async () => {
  const { sessionId, sandboxId } = await session({ status: 'provisioning', externalId: null, metadata: {} });
  const creating = creates.length;
  const polled = start(sessionId, '?wait_ms=4000');
  await Bun.sleep(600);
  await landStop(sandboxId, new Date());

  const answer = await polled;
  expect(answer.stage).toBe('stopped');
  const rows = await rowsOf(sessionId);
  expect(rows.map((r) => [r.sandboxId, r.status, r.externalId])).toEqual([[sandboxId, 'stopped', null]]);
  expect(creates.length).toBe(creating);
}, 30_000);

test('an open during a Stop never answers ready, and its wait ends stopped once the Stop lands', async () => {
  const claimedAt = new Date();
  const { sessionId, sandboxId } = await session({
    status: 'active',
    externalId: 'sbx_stop_wins_live',
    metadata: { lifecycleStopClaim: { token: 'stop-wins', claimedAtMs: claimedAt.getTime() } },
  });
  // One-shot: the box is going away, so the answer is neither ready nor a wake.
  const once = await start(sessionId);
  expect(once.stage).toBe('starting');
  expect(once.reason).toBe('runtime_stopping');

  const polled = start(sessionId, '?wait_ms=4000');
  await Bun.sleep(600);
  await landStop(sandboxId, claimedAt, 'sbx_stop_wins_live');
  expect((await polled).stage).toBe('stopped');
  const rows = await rowsOf(sessionId);
  expect(rows.map((r) => [r.sandboxId, r.status])).toEqual([[sandboxId, 'stopped']]);
}, 30_000);

test('an open formed after the Stop still wakes the session', async () => {
  const { sessionId, sandboxId } = await session({ status: 'provisioning', externalId: null, metadata: {} });
  await landStop(sandboxId, new Date(Date.now() - 1_000));
  const answer = await start(sessionId);
  expect(answer.stage).toBe('provisioning');
  expect(answer.reason).toBe('ephemeral_wake');
  const rows = await rowsOf(sessionId);
  expect(rows.some((r) => r.sandboxId === sandboxId && r.status === 'stopped')).toBe(false);
}, 30_000);
