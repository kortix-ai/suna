/**
 * AN INSTANCE MUST NOT ACCEPT A PROMPT IT CANNOT DELIVER.
 *
 * Several local API instances (the primary `pnpm dev` and each worktree) share
 * one database. `claimDueLifecycleCommands` never claims a command whose
 * sandbox another instance provisioned (services/sessions/instance-scope.ts). The HTTP
 * accept paths had no such check: they answered 200/202, stored the prompt as a
 * command, and no worker on the accepting instance could ever take it. When the
 * owning instance was not running, the row stayed `queued` with `attempts = 0`
 * and the client waited on a turn that never started (2026-09-30: a first
 * prompt from project home, on web and on mobile).
 *
 * This suite drives the two accept routes over HTTP with a real token:
 * `POST .../sessions/:id/prompts` and `POST .../sessions/warm/claim`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import {
  accountMembers,
  accounts,
  projectMembers,
  projectSessions,
  projects,
  sessionLifecycleCommands,
  sessionSandboxes,
} from '@kortix/db';
import { config } from '../lib/config';
import { db } from '../lib/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { upsertResourceGrant } from '../iam/resource-grants';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const AGENT = 'kortix';
const MINE = 'accept-owner-test';
const PEER = 'accept-peer-test';

const ORIGINAL_INSTANCE = config.KORTIX_INSTANCE_ID;
let tokenId = '';
let memberKey = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'instance-scope-accept-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'instance-scope-accept-test-project',
    repoUrl: 'https://example.com/instance-scope-accept-test.git',
  });
  await insertIntoView(db, accountMembers, [
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: MEMBER, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
  ]);
  await upsertResourceGrant({
    accountId: ACCOUNT,
    projectId: PROJECT,
    resourceType: 'agent',
    resourceId: AGENT,
    principalType: 'member',
    principalId: MEMBER,
    grantedBy: MANAGER,
  });
  const token = await createAccountToken({
    accountId: ACCOUNT,
    userId: MEMBER,
    projectId: PROJECT,
    name: 'instance-scope-accept-test',
    agentGrant: null as any,
  });
  tokenId = token.tokenId;
  memberKey = token.secretKey;
});

afterEach(() => {
  config.KORTIX_INSTANCE_ID = ORIGINAL_INSTANCE;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, PROJECT));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, PROJECT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

/** A running session the member owns, with a sandbox row stamped `boxInstanceId`. */
async function seedSession(boxInstanceId: string, opts: { warm?: boolean } = {}): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sessionId,
    baseRef: 'main',
    agentName: AGENT,
    status: 'running',
    createdBy: MEMBER,
    visibility: 'private',
    metadata: opts.warm ? { warm: true } : {},
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    status: 'active',
    metadata: { instanceId: boxInstanceId },
  });
  return sessionId;
}

function post(path: string, body: unknown) {
  return app.request(`/v1/projects/${PROJECT}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const prompt = () => ({
  client_message_id: crypto.randomUUID(),
  message_id: `msg_${Date.now().toString(16).padStart(12, '0').slice(-12)}aAbBcCdDeEfF12`,
  parts: [{ type: 'text', text: 'say hi' }],
});

const commandCount = async (sessionId: string) =>
  (
    await db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.sessionId, sessionId))
  ).length;

describe('POST /prompts — instance scope', () => {
  test("refuses a prompt for another instance's sandbox and stores nothing", async () => {
    config.KORTIX_INSTANCE_ID = MINE;
    const sessionId = await seedSession(PEER);

    const res = await post(`/sessions/${sessionId}/prompts`, prompt());

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'SESSION_OWNED_BY_OTHER_INSTANCE',
      owner_instance: PEER,
    });
    expect(await commandCount(sessionId)).toBe(0);
  });

  test("queues a prompt for this instance's own sandbox", async () => {
    config.KORTIX_INSTANCE_ID = MINE;
    const sessionId = await seedSession(MINE);

    const res = await post(`/sessions/${sessionId}/prompts`, prompt());

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: 'queued' });
    expect(await commandCount(sessionId)).toBe(1);
  });

  test('with no instance id configured, queues a prompt for any sandbox', async () => {
    config.KORTIX_INSTANCE_ID = undefined;
    const sessionId = await seedSession(PEER);

    const res = await post(`/sessions/${sessionId}/prompts`, prompt());

    expect(res.status).toBe(202);
    expect(await commandCount(sessionId)).toBe(1);
  });
});

describe('POST /sessions/warm/claim — instance scope', () => {
  const claim = (sessionId: string) =>
    post('/sessions/warm/claim', {
      session_id: sessionId,
      pending_prompt: { text: 'say hi', agent: AGENT, model: null, variant: null },
    });
  const isWarm = async (sessionId: string) => {
    const [row] = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId));
    return (row?.metadata as Record<string, unknown> | null)?.warm === true;
  };

  test("refuses another instance's warm session; it keeps its marker and gets no prompt", async () => {
    config.KORTIX_INSTANCE_ID = MINE;
    const sessionId = await seedSession(PEER, { warm: true });

    const res = await claim(sessionId);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'WARM_SESSION_ALREADY_CLAIMED' });
    expect(await isWarm(sessionId)).toBe(true);
    expect(await commandCount(sessionId)).toBe(0);
    // Out of the warm pool for the next test: the lookup returns the newest row.
    await db.delete(projectSessions).where(eq(projectSessions.sessionId, sessionId));
  });

  test("claims this instance's own warm session and stores its first prompt", async () => {
    config.KORTIX_INSTANCE_ID = MINE;
    const sessionId = await seedSession(MINE, { warm: true });

    const res = await claim(sessionId);

    expect(res.status).toBe(200);
    expect(await isWarm(sessionId)).toBe(false);
    expect(await commandCount(sessionId)).toBe(1);
  });
});
