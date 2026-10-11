/**
 * Integration test (real app + real PostgreSQL): a keep-alive poll never
 * undoes a deliberate stop of an ephemeral session.
 *
 * A stop of an ephemeral box deletes it and leaves the row stopped with no
 * external id, marked retired. The open tab keeps polling
 * `/start?keep_stopped=1`. That poll used to claim the retired row and
 * allocate a fresh box before it ever looked at `keep_stopped`, so a tab left
 * open brought back every session the user had just stopped. The poll must
 * answer `stopped` and leave the row alone; an explicit `/start` still wakes.
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

let fixture: { project: SeededProject; sessionId: string; sandboxId: string; token: string } | null = null;
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
  config.PLATINUM_API_KEY = 'pt_test_keep_stopped';
  config.ALLOWED_SANDBOX_PROVIDERS = ['platinum'];
  // A loopback callback URL refuses every allocation; this test is about the
  // poll refusing it on its own.
  (config as unknown as Record<string, unknown>).KORTIX_URL = 'https://api.keep-stopped.example';

  const project = await seedProject('keep-stopped');
  const userId = crypto.randomUUID();
  await insertIntoView(db, accountMembers, { accountId: project.account_id, userId, accountRole: 'owner' });
  await insertIntoView(db, projectMembers, {
    accountId: project.account_id,
    projectId: project.project_id,
    userId,
    projectRole: 'manager',
  });
  const sessionId = await seedSession(project, userId);
  await db
    .update(projectSessions)
    .set({ agentName: 'main', sandboxProvider: 'platinum' })
    .where(eq(projectSessions.sessionId, sessionId));
  const sandboxId = crypto.randomUUID();
  // The row a manual stop of an ephemeral box leaves behind.
  await db.insert(sessionSandboxes).values({
    sandboxId,
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    provider: 'platinum',
    status: 'stopped',
    externalId: null,
    metadata: {
      stopReason: 'manual',
      [EPHEMERAL_RETIRED_KEY]: 'keep-stopped-old-box',
      platinumCreateAttempt: 1,
    },
  });
  const token = await createAccountToken({ accountId: project.account_id, userId, name: 'keep-stopped-pat' });
  fixture = { project, sessionId, sandboxId, token: token.secretKey };
});

afterAll(async () => {
  // Let the explicit start's detached allocation settle against the stub.
  await Bun.sleep(500);
  if (fixture) {
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sessionId, fixture.sessionId));
    await removeSeeded([fixture.project]);
  }
  stubServer?.stop(true);
  for (const [key, value] of Object.entries(savedConfig)) {
    (config as unknown as Record<string, unknown>)[key] = value;
  }
});

async function start(query = ''): Promise<{ stage?: string; reason?: string }> {
  const res = await app.request(
    `/v1/projects/${fixture!.project.project_id}/sessions/${fixture!.sessionId}/start${query}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture!.token}` },
      body: JSON.stringify({}),
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { stage?: string; reason?: string };
}

async function sandboxRows() {
  return db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, fixture!.sessionId));
}

test('a keep-alive poll leaves a stopped ephemeral session stopped, and allocates nothing', async () => {
  expect(fixture).not.toBeNull();
  for (let i = 0; i < 3; i++) {
    const answer = await start('?keep_stopped=1');
    expect(answer.stage).toBe('stopped');
  }
  const rows = await sandboxRows();
  expect(rows.map((r) => [r.sandboxId, r.status, r.externalId])).toEqual([[fixture!.sandboxId, 'stopped', null]]);
  expect((rows[0]!.metadata as Record<string, unknown>)[EPHEMERAL_RETIRED_KEY]).toBe('keep-stopped-old-box');
}, 30_000);

test('an explicit start still wakes it', async () => {
  const answer = await start();
  expect(answer.stage).toBe('provisioning');
  expect(answer.reason).toBe('ephemeral_wake');
  // The retired row was claimed: the old stopped row no longer exists.
  const rows = await sandboxRows();
  expect(rows.some((r) => r.sandboxId === fixture!.sandboxId && r.status === 'stopped')).toBe(false);
}, 30_000);
