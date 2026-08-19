/**
 * START AND FOLLOW-UP MUST PASS THE SAME GATE.
 *
 * A built-in project `member` holds project.read + project.session.start/read,
 * and NOT project.write. That role is "read + run": it exists so someone can
 * use a project's agents without being able to reconfigure the project.
 *
 * It did not work. A member could open a session and get its FIRST prompt
 * answered — that prompt rides `POST /projects/:id/sessions` as the
 * `pending_prompt` stash, floored `'session'` — and then every follow-up 403'd
 * with "Your role on this project doesn't let you change this project. Ask an
 * account owner or admin to grant you a higher role." A follow-up lands on
 * `POST /projects/:id/sessions/:sid/prompts`, which was floored `'write'`.
 * One user action, two contradictory gates: allowed to begin the conversation,
 * refused to continue it.
 *
 * The whole prompt QUEUE had the same split (send / un-queue / retry / hold),
 * so a member who somehow got a message in could not cancel or retry it either.
 *
 * This suite pins the floor on all four queue routes with a plain HUMAN token.
 * That matters: the sibling suite
 * `integration-project-write-leaf-gates-http.test.ts` drives the same routes
 * through the agent-grant fold, where project.read/project.write are EXEMPT
 * (AGENT_GRANT_EXEMPT_ACTIONS) — the coarse floor always passes there, so it
 * cannot see this bug. Only a real member's token can.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projectSessions, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { upsertResourceGrant } from '../iam/resource-grants';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
/** The agent this project's sessions run. */
const AGENT = 'kortix';

const minted: string[] = [];
let memberKey = '';
let managerKey = '';

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'member-prompt-gate-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'member-prompt-gate-test-project',
    repoUrl: 'https://example.com/member-prompt-gate-test.git',
  });
  await db.insert(accountMembers).values([
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await db.insert(projectMembers).values([
    { accountId: ACCOUNT, projectId: PROJECT, userId: MEMBER, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
  ]);
  // A session the member owns and is therefore allowed to see. Without it the
  // queue routes stop at `loadVisibleSession` → 404, which would mask a
  // regression that reintroduces a 403 further down.
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: SESSION,
    baseRef: 'main',
    agentName: AGENT,
    status: 'running',
    createdBy: MEMBER,
    visibility: 'private',
  });
  // Agents are deny-by-default for a member (iam/resource-grants.ts), so the
  // member has to actually be granted the agent this session runs. Without it
  // every route below refuses on AGENT access and this suite would no longer be
  // measuring the project-role floor it exists to measure.
  await upsertResourceGrant({
    accountId: ACCOUNT,
    projectId: PROJECT,
    resourceType: 'agent',
    resourceId: AGENT,
    principalType: 'member',
    principalId: MEMBER,
    grantedBy: MANAGER,
  });

  memberKey = await mint(MEMBER);
  managerKey = await mint(MANAGER);
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

/** A plain human PAT — no agent grant, so the coarse project floor is live. */
async function mint(userId: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId: PROJECT,
    name: 'member-prompt-gate-test',
    agentGrant: null as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

function req(method: string, path: string, secret: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** The exact denial the bug produced: the project floor refusing a role. */
async function roleDenied(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const text = JSON.stringify(await res.json().catch(() => ({})));
  return /doesn't let you|do not have access to this project/i.test(text);
}

const base = `/v1/projects/${PROJECT}/sessions/${SESSION}`;
const wireMessageId = () =>
  `msg_${Date.now().toString(16).padStart(12, '0').slice(-12)}aAbBcCdDeEfF12`;

const R8_SRC = await Bun.file(
  new URL('../projects/routes/r8.ts', import.meta.url).pathname,
).text();

/**
 * The `loadProjectForUser` floor of one registered handler, selected by method
 * + OpenAPI path. Scoped per handler: r8.ts registers 17 routes across three
 * different floors, so a whole-file match would read a neighbour's.
 */
function handlerFloor(method: string, path: string): string {
  const block = R8_SRC.split('projectsApp.openapi(').find(
    (b) => b.includes(`method: '${method.toLowerCase()}'`) && b.includes(`path: '${path}'`),
  );
  if (!block) throw new Error(`no ${method} ${path} handler found in r8.ts`);
  const floor = block.match(/loadProjectForUser\(c, projectId, '(\w+)'\)/);
  if (!floor) throw new Error(`no loadProjectForUser floor in ${method} ${path}`);
  return floor[1]!;
}

/** Every route a user touches to send, cancel, retry, or hold a prompt. */
const QUEUE_ROUTES: {
  name: string;
  method: string;
  path: string;
  registeredPath: string;
  body?: unknown;
}[] = [
  {
    name: 'POST /prompts (the follow-up prompt itself)',
    method: 'POST',
    path: `${base}/prompts`,
    registeredPath: '/{projectId}/sessions/{sessionId}/prompts',
    body: {
      client_message_id: crypto.randomUUID(),
      message_id: wireMessageId(),
      parts: [{ type: 'text', text: 'follow-up' }],
    },
  },
  {
    name: 'DELETE /prompts/:promptId (un-queue)',
    method: 'DELETE',
    path: `${base}/prompts/${crypto.randomUUID()}`,
    registeredPath: '/{projectId}/sessions/{sessionId}/prompts/{promptId}',
  },
  {
    name: 'POST /prompts/:promptId/retry (retry / send now)',
    method: 'POST',
    path: `${base}/prompts/${crypto.randomUUID()}/retry`,
    registeredPath: '/{projectId}/sessions/{sessionId}/prompts/{promptId}/retry',
  },
  {
    name: 'POST /prompts/hold (stop reaches the queue)',
    method: 'POST',
    path: `${base}/prompts/hold`,
    registeredPath: '/{projectId}/sessions/{sessionId}/prompts/hold',
    body: { held: true },
  },
];

describe('project member — session prompt queue', () => {
  for (const route of QUEUE_ROUTES) {
    test(`${route.name} is not refused for a member's role`, async () => {
      const res = await req(route.method, route.path, memberKey, route.body);
      expect(await roleDenied(res)).toBe(false);
      // Belt and braces: no 403 of any kind. A member running their own session
      // has cleared every authorization these routes apply.
      expect(res.status).not.toBe(403);
    });

    test(`${route.name} is floored 'session', not 'write'`, async () => {
      // Read the floor off the handler itself. The behavioural test above can
      // only prove the CURRENT floor admits a member; this pins WHICH floor,
      // so a future edit back to 'write' fails here with the reason named
      // rather than as a puzzling status change.
      expect(handlerFloor(route.method, route.registeredPath)).toBe('session');
    });
  }

  test('POST /prompts accepts a member follow-up onto the queue', async () => {
    const res = await req('POST', `${base}/prompts`, memberKey, {
      client_message_id: crypto.randomUUID(),
      message_id: wireMessageId(),
      parts: [{ type: 'text', text: 'the second thing I said' }],
    });
    // 202 = queued. This is the exact call that returned 403 before the fix.
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: 'queued' });
  });

  test('starting a session stays open to a member (the same floor)', async () => {
    // The first prompt's path. It always worked; it is asserted here so the two
    // gates can never drift apart again without a test noticing.
    const res = await req('POST', `${base}/start`, memberKey);
    expect(await roleDenied(res)).toBe(false);
  });
});

describe('project member — agents are deny-by-default', () => {
  // The second half of the owner's report: the composer showed NO agent
  // selected while prompts still ran, because an unnamed agent silently
  // resolved to the manifest's fully-privileged `default_agent`.
  const NO_ACCESS = /don't have access to (any agent|the .* agent)/i;

  test('a prompt naming an agent the member has no grant for is refused', async () => {
    const res = await req('POST', `${base}/prompts`, memberKey, {
      client_message_id: crypto.randomUUID(),
      message_id: wireMessageId(),
      parts: [{ type: 'text', text: 'run as something else' }],
      overrides: { agent: 'an-agent-nobody-granted-me' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string; code?: string; accessible_agents?: string[] };
    expect(body.message ?? '').toMatch(NO_ACCESS);
    // The 403 has to be actionable: name the agents that WOULD work.
    expect(body.code).toBe('agent_not_accessible');
    expect(body.accessible_agents).toEqual([AGENT]);
  });

  test('the agent-switch refusal is about the AGENT, not the role', async () => {
    // Guards against a future change that "fixes" this by reintroducing the
    // project.write floor — that would 403 too, with the wrong reason.
    const res = await req('POST', `${base}/prompts`, memberKey, {
      client_message_id: crypto.randomUUID(),
      message_id: wireMessageId(),
      parts: [{ type: 'text', text: 'x' }],
      overrides: { agent: 'an-agent-nobody-granted-me' },
    });
    expect(await roleDenied(res)).toBe(false);
  });

  test('the granted agent still passes, so the gate is scoping and not a block', async () => {
    const res = await req('POST', `${base}/prompts`, memberKey, {
      client_message_id: crypto.randomUUID(),
      message_id: wireMessageId(),
      parts: [{ type: 'text', text: 'stay on my agent' }],
      overrides: { agent: AGENT },
    });
    expect(res.status).toBe(202);
  });
});

describe('project member — project.write is still withheld', () => {
  // The fix must not have widened `member` into an editor. These routes gate on
  // the project.write floor and must keep refusing exactly as before.
  const WRITE_ROUTES: { name: string; method: string; path: string; body?: unknown }[] = [
    {
      name: 'PATCH /onboarding',
      method: 'PATCH',
      path: `/v1/projects/${PROJECT}/onboarding`,
      body: { dismissed: true },
    },
    {
      name: 'POST /change-requests',
      method: 'POST',
      path: `/v1/projects/${PROJECT}/change-requests`,
      body: { head_ref: 'x', base_ref: 'main' },
    },
    {
      name: 'POST /sessions/:sid/commit-push',
      method: 'POST',
      path: `${base}/commit-push`,
      body: { message: 'x' },
    },
  ];

  for (const route of WRITE_ROUTES) {
    test(`${route.name} still refuses a member`, async () => {
      const res = await req(route.method, route.path, memberKey, route.body);
      expect(await roleDenied(res)).toBe(true);
    });
  }
});
