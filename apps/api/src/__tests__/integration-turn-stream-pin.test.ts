/**
 * Integration test (real local PostgreSQL): the `runtime_session` turn-stream
 * pin is a daemon-only durable write (KRTX-1607).
 *
 * `POST /v1/projects/:projectId/turn-stream` with `kind: 'runtime_session'`
 * overwrites `project_sessions.opencode_session_id` — the session's durable
 * root-conversation pin consumed by the daemon resume path, the transcript
 * mirror and the channel relays. Only the session's own sandbox credential may
 * pin it. A plain project member reaches the route's human branch (project
 * membership + project.read, lifecycle kinds exempt from connector.write), so
 * without the guard they could overwrite the pin of ANY session in the project
 * — including a private session they get a 404 on when they try to open it.
 *
 * Real app, real tokens, real rows: this file asserts the shipped HTTP route
 * and the persisted column, not a mock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import {
  accountMembers,
  accounts,
  projectMembers,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import {
  type SeededProject,
  seedProject,
  seedSession,
} from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const minted: string[] = [];
let project: SeededProject;
let sessionId: string;

beforeAll(async () => {
  project = await seedProject('turn-stream-pin');
  // The session is private to its creator by default — the member cannot open it.
  sessionId = await seedSession(project, OWNER);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  await db.execute(sql`
    insert into auth.users (id, email) values
      (${OWNER}::uuid, ${`owner-${OWNER}@example.test`}),
      (${MEMBER}::uuid, ${`member-${MEMBER}@example.test`})`);
  await insertIntoView(db, accountMembers, [
    { accountId: project.account_id, userId: OWNER, accountRole: 'member' },
    { accountId: project.account_id, userId: MEMBER, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
  // The session's own box, scoped to exactly this session — the credential the
  // daemon inside it holds.
  await db.insert(sessionSandboxes).values({
    sandboxId: sessionId,
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    status: 'active',
  });
});

afterAll(async () => {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId));
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.projectId, project.project_id));
  await db.delete(accounts).where(eq(accounts.accountId, project.account_id));
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${MEMBER}::uuid)`);
});

async function mint(userId: string, options: { sessionId?: string } = {}): Promise<string> {
  const token = await createAccountToken({
    accountId: project.account_id,
    userId,
    projectId: project.project_id,
    sessionId: options.sessionId ?? null,
    name: 'turn-stream-pin',
  });
  minted.push(token.tokenId);
  return token.secretKey;
}

async function pinOf(): Promise<string | null> {
  const [row] = await db
    .select({ runtimeSessionId: projectSessions.runtimeSessionId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  return row?.runtimeSessionId ?? null;
}

function turnStream(secret: string, body: Record<string, unknown>) {
  return app.request(`/v1/projects/${project.project_id}/turn-stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...body }),
  });
}

describe('POST /v1/projects/:projectId/turn-stream — runtime_session pin authority', () => {
  test('the member cannot even open the private session they target', async () => {
    const res = await app.request(`/v1/projects/${project.project_id}/sessions/${sessionId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${await mint(MEMBER)}` },
    });
    expect(res.status).toBe(404);
  });

  test('a plain member posting kind runtime_session is refused and the pin stays unchanged', async () => {
    expect(await pinOf()).toBeNull();
    const res = await turnStream(await mint(MEMBER), {
      kind: 'runtime_session',
      runtime_session_id: 'oc_member_chosen',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'runtime_session requires a sandbox token' });
    expect(await pinOf()).toBeNull();
  });

  test('the pre-W3 alias kind opencode_session is refused for a member too', async () => {
    const res = await turnStream(await mint(MEMBER), {
      kind: 'opencode_session',
      opencode_session_id: 'oc_member_chosen_alias',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'runtime_session requires a sandbox token' });
    expect(await pinOf()).toBeNull();
  });

  test('the session sandbox credential pins its own session', async () => {
    const res = await turnStream(await mint(OWNER, { sessionId }), {
      kind: 'runtime_session',
      runtime_session_id: 'oc_daemon_root',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await pinOf()).toBe('oc_daemon_root');
  });

  test('a sandbox credential for a different session cannot pin this one', async () => {
    const otherSession = crypto.randomUUID();
    await db.insert(sessionSandboxes).values({
      sandboxId: otherSession,
      sessionId: otherSession,
      accountId: project.account_id,
      projectId: project.project_id,
      status: 'active',
    });
    try {
      const res = await turnStream(await mint(OWNER, { sessionId: otherSession }), {
        kind: 'runtime_session',
        runtime_session_id: 'oc_other_box',
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'sandbox token is not scoped to this session' });
      expect(await pinOf()).toBe('oc_daemon_root');
    } finally {
      await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, otherSession));
    }
  });
});
