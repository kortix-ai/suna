/**
 * A MEMBER PICKS THE MODEL. A MANAGER CONFIGURES IT.
 *
 * Choosing which model answers THIS session is a session-level act: it is what
 * the composer's model picker does, and "read + run" is exactly the role that
 * runs sessions. Choosing which models the PROJECT offers at all
 * (`PUT /model-enablement`) is configuration, and stays manager-tier.
 *
 * This suite pins that split on a plain HUMAN token, because only a real
 * member's token can see it. The sibling suite
 * `integration-project-write-leaf-gates-http.test.ts` drives
 * `PUT /sessions/:sid/model` through the agent-grant fold, where project.read /
 * project.write are EXEMPT (AGENT_GRANT_EXEMPT_ACTIONS) — the coarse floor
 * always passes there, so a floor regression to 'write' would be invisible to
 * it.
 *
 * Three facts are pinned:
 *   1. A member can READ the enabled-model list (`GET /model-picker`). Several
 *      read leaves (project.customize.read, project.secret.read, …) moved out
 *      of the member baseline into MANAGER_EXTRAS; the model list must NOT have
 *      followed them, or the picker has nothing to offer.
 *   2. A member can WRITE the session model on a session they own
 *      (`PUT /sessions/:sid/model`), and that route is floored 'session'.
 *   3. A member still CANNOT write project-level model configuration
 *      (`PUT /model-enablement`) — that asserts project.customize.write.
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

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'member-model-gate-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'member-model-gate-test-project',
    repoUrl: 'https://example.com/member-model-gate-test.git',
    // `GET /model-picker` and `PUT /model-enablement` both 404 with
    // `llm_gateway_disabled` unless the project has the gateway on. Turn it on
    // so this suite measures the ROLE gate and not the feature flag.
    metadata: { experimental: { llm_gateway: true } },
  });
  await db.insert(accountMembers).values([
    { userId: MEMBER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
    { userId: MANAGER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await db.insert(projectMembers).values([
    { accountId: ACCOUNT, projectId: PROJECT, userId: MEMBER, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
  ]);
  // A RUNNING session the member OWNS. Ownership matters: `mayChangeSessionModel`
  // gates on owner-or-manager (a live model change restarts opencode and would
  // kill someone else's in-flight turn), and `canChangeSessionModel` refuses a
  // terminal status. Both must be satisfied for the role floor to be what this
  // suite is actually reading.
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
  // Agents are deny-by-default for a member (iam/resource-grants.ts). Without
  // the grant every session-scoped route refuses on AGENT access and this suite
  // would stop measuring the project-role floor it exists to measure.
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
    name: 'member-model-gate-test',
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

/** The exact denial a too-high floor produces: the project gate refusing a role. */
async function roleDenied(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const text = JSON.stringify(await res.json().catch(() => ({})));
  return /doesn't let you|do not have access to this project|permission to perform this action/i.test(
    text,
  );
}

/**
 * The `loadProjectForUser` floor of one registered handler, selected by method
 * + OpenAPI path. Scoped per handler because each source file registers many
 * routes across different floors, so a whole-file match would read a
 * neighbour's.
 */
function handlerFloor(source: string, method: string, path: string): string {
  const block = source.split('projectsApp.openapi(').find(
    (b) => b.includes(`method: '${method.toLowerCase()}'`) && b.includes(`path: '${path}'`),
  );
  if (!block) throw new Error(`no ${method} ${path} handler found`);
  const floor = block.match(/loadProjectForUser\(c, projectId, '(\w+)'\)/);
  if (!floor) throw new Error(`no loadProjectForUser floor in ${method} ${path}`);
  return floor[1]!;
}

const SESSION_SCOPE_SRC = await Bun.file(
  new URL('../projects/routes/session-scope.ts', import.meta.url).pathname,
).text();

const base = `/v1/projects/${PROJECT}`;

describe('project member — model selection', () => {
  test('can READ the enabled-model list', async () => {
    const res = await req('GET', `${base}/model-picker`, memberKey);
    expect(await roleDenied(res)).toBe(false);
    expect(res.status).toBe(200);
  });

  test('sees the SAME model list a manager sees', async () => {
    // The real assertion. "200, not 403" would still pass if a capability-scoped
    // filter quietly emptied the list for a member — which is exactly what an
    // over-gated picker looks like from the composer. The member's payload has
    // to be byte-identical to the manager's: the ROLE must not narrow the
    // catalog, only project-level enablement may.
    //
    // Deliberately a comparison, not a count: how many models this account can
    // serve depends on its plan entitlement (`accountMayUseManagedModels`) and
    // on which BYOK secrets exist, neither of which is a role question, and a
    // synthetic test account legitimately has none of either.
    const [memberRes, managerRes] = await Promise.all([
      Promise.resolve(req('GET', `${base}/model-picker`, memberKey)),
      Promise.resolve(req('GET', `${base}/model-picker`, managerKey)),
    ]);
    const asMember = (await memberRes.json()) as any;
    const asManager = (await managerRes.json()) as any;
    expect(asMember.models).toEqual(asManager.models);
    expect(asMember.defaultModel).toEqual(asManager.defaultModel);
  });

  test('can WRITE the session model on a session it owns', async () => {
    const res = await req('PUT', `${base}/sessions/${SESSION}/model`, memberKey, {
      opencode_model: 'kortix/deepseek-v4-flash',
    });
    expect(await roleDenied(res)).toBe(false);
    expect(res.status).not.toBe(403);
    // The member clears every AUTHORIZATION gate on this route. What it can
    // still hit is the servability gate — a synthetic account with no plan
    // entitlement cannot serve a managed model — and that is a 400 naming the
    // model, never a role refusal. Pin the distinction so a future 403 cannot
    // hide behind "the test only checked for not-403".
    if (res.status === 400) {
      expect(await res.json()).toMatchObject({ code: 'INVALID_SESSION_MODEL' });
    } else {
      expect(res.status).toBe(200);
    }
  });

  test("session model write is floored 'session', not 'write'", () => {
    // The behavioural test above can only prove the CURRENT floor admits a
    // member. This pins WHICH floor, so a future edit back to 'write' fails
    // here with the reason named rather than as a puzzling status change.
    expect(
      handlerFloor(SESSION_SCOPE_SRC, 'PUT', '/{projectId}/sessions/{sessionId}/model'),
    ).toBe('session');
  });

  test('still CANNOT change project-level model configuration', async () => {
    const res = await req('PUT', `${base}/model-enablement`, memberKey, {
      modelOverrides: { 'kortix/deepseek-v4-flash': false },
    });
    expect(res.status).toBe(403);
    const text = JSON.stringify(await res.json().catch(() => ({})));
    expect(text).toContain('project.customize.write');
  });

  test('a manager is not refused project-level model configuration', async () => {
    const res = await req('PUT', `${base}/model-enablement`, managerKey, { modelOverrides: {} });
    expect(await roleDenied(res)).toBe(false);
    expect(res.status).not.toBe(403);
  });
});
