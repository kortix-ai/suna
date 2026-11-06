/**
 * Integration test (real local DB): ONE workspace scope in the IAM engine
 * (Workspaces, design.md §5).
 *
 *   - `{ type: 'workspace', id }` + a `workspace.*` action gives the same verdict
 *     as `{ type: 'project', id }` + the legacy action, for every role;
 *   - the reach rule on a 1:1 workspace and on a `split_pending` legacy account
 *     (an account-scope grant reaches every project of the account; a project
 *     grant reaches only its own project);
 *   - a workspace of another account is never reached;
 *   - an agent session that acts as its launcher never inherits workspace
 *     administration; a plain PAT of the same person keeps it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountMembers, accountTokens, accounts, projectMembers, projects, serviceAccounts } from '@kortix/db';
import { toWorkspaceAction } from '@kortix/shared/workspace-actions';
import { db } from '../shared/db';
import { authorize, workspaceRoleFor, type Obj } from '../iam/authorize';
import { actorForUser, tokenCredential, type Actor } from '../iam/actor';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam';
import { insertIntoView } from './helpers/compat-views';
import { myKortixAgentGrant } from '../projects/lib/my-kortix-agent';

const uid = () => crypto.randomUUID();

// A 1:1 workspace: one account, one active project.
const ONE_ACCOUNT = uid();
const ONE_WS = uid();
// A legacy account with two active projects, both split-pending.
const LEGACY_ACCOUNT = uid();
const LEGACY_A = uid();
const LEGACY_B = uid();

const ws = (id: string): Obj => ({ type: 'workspace', id });
const proj = (id: string): Obj => ({ type: 'project', id });

const people = {
  owner: uid(),
  admin: uid(),
  member: uid(),
  manager: uid(),
  projectMember: uid(),
};

async function seedPeople(accountId: string, projectId: string) {
  await insertIntoView(db, accountMembers, { userId: people.owner, accountId, accountRole: 'owner' });
  await insertIntoView(db, accountMembers, { userId: people.admin, accountId, accountRole: 'admin' });
  await insertIntoView(db, accountMembers, { userId: people.member, accountId, accountRole: 'member' });
  await insertIntoView(db, accountMembers, { userId: people.manager, accountId, accountRole: 'member' });
  await insertIntoView(db, accountMembers, { userId: people.projectMember, accountId, accountRole: 'member' });
  await insertIntoView(db, projectMembers, { accountId, projectId, userId: people.manager, projectRole: 'manager' });
  await insertIntoView(db, projectMembers, { accountId, projectId, userId: people.projectMember, projectRole: 'member' });
}

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: ONE_ACCOUNT, name: 'ws-scope-one' },
    { accountId: LEGACY_ACCOUNT, name: 'ws-scope-legacy' },
  ]);
  await db.insert(projects).values([
    { projectId: ONE_WS, accountId: ONE_ACCOUNT, name: 'one', repoUrl: 'https://example.com/one.git' },
    { splitPending: true, projectId: LEGACY_A, accountId: LEGACY_ACCOUNT, name: 'a', repoUrl: 'https://example.com/a.git' },
    { splitPending: true, projectId: LEGACY_B, accountId: LEGACY_ACCOUNT, name: 'b', repoUrl: 'https://example.com/b.git' },
  ]);
  await seedPeople(ONE_ACCOUNT, ONE_WS);
  // In the legacy account the project roles sit on project A only.
  await seedPeople(LEGACY_ACCOUNT, LEGACY_A);
});

afterAll(async () => {
  for (const accountId of [ONE_ACCOUNT, LEGACY_ACCOUNT]) {
    await db.delete(projects).where(eq(projects.accountId, accountId));
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
  }
});

const PROBED = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  PROJECT_ACTIONS.PROJECT_DELETE,
  ACCOUNT_ACTIONS.BILLING_READ,
  ACCOUNT_ACTIONS.MEMBER_INVITE,
  ACCOUNT_ACTIONS.ACCOUNT_WRITE,
];

describe('one workspace scope: the workspace shape equals the legacy shapes', () => {
  for (const [role, userId] of Object.entries(people)) {
    test(`${role}: every probed action has the same verdict under both names and both shapes`, async () => {
      for (const [accountId, projectId] of [
        [ONE_ACCOUNT, ONE_WS],
        [LEGACY_ACCOUNT, LEGACY_A],
        [LEGACY_ACCOUNT, LEGACY_B],
      ] as const) {
        const actor = actorForUser(userId, accountId);
        for (const action of PROBED) {
          const legacyObj: Obj = action.startsWith('project.') ? proj(projectId) : { type: 'account' };
          const legacy = await authorize(actor, action, legacyObj);
          const workspace = await authorize(actor, toWorkspaceAction(action), ws(projectId));
          expect({ role, projectId, action, ...workspace }).toEqual({ role, projectId, action, ...legacy });
        }
      }
    });
  }
});

describe('reach rule', () => {
  test('1:1: owner and admin reach the workspace; a plain member reaches it at the member tier (membership is access)', async () => {
    expect((await authorize(actorForUser(people.owner, ONE_ACCOUNT), 'workspace.members.manage', ws(ONE_WS))).allowed).toBe(true);
    expect((await authorize(actorForUser(people.admin, ONE_ACCOUNT), 'workspace.write', ws(ONE_WS))).allowed).toBe(true);
    const plain = actorForUser(people.member, ONE_ACCOUNT);
    expect(await authorize(plain, 'workspace.read', ws(ONE_WS))).toEqual({ allowed: true, reason: 'role' });
    expect(await authorize(plain, 'workspace.session.start', ws(ONE_WS))).toEqual({ allowed: true, reason: 'role' });
    // The member tier, not more: managing people stays with managers.
    expect(await authorize(plain, 'workspace.members.manage', ws(ONE_WS))).toEqual({
      allowed: false,
      reason: 'project_role_insufficient',
    });
    expect(await workspaceRoleFor(plain, ONE_WS)).toBe('member');
    expect(await workspaceRoleFor(actorForUser(people.owner, ONE_ACCOUNT), ONE_WS)).toBe('owner');
  });

  test('split_pending: a plain account member reaches no project without a grant', async () => {
    const plain = actorForUser(people.member, LEGACY_ACCOUNT);
    for (const projectId of [LEGACY_A, LEGACY_B]) {
      expect(await authorize(plain, 'workspace.read', ws(projectId))).toEqual({ allowed: false, reason: 'no_project_membership' });
    }
  });

  test('split_pending: an account-scope grant reaches every project of the account', async () => {
    for (const projectId of [LEGACY_A, LEGACY_B]) {
      expect((await authorize(actorForUser(people.admin, LEGACY_ACCOUNT), 'workspace.write', ws(projectId))).allowed).toBe(true);
    }
  });

  test('split_pending: a project grant reaches only its own project', async () => {
    const actor = actorForUser(people.manager, LEGACY_ACCOUNT);
    expect((await authorize(actor, 'workspace.write', ws(LEGACY_A))).allowed).toBe(true);
    expect(await authorize(actor, 'workspace.write', ws(LEGACY_B))).toEqual({ allowed: false, reason: 'no_project_membership' });
  });

  test('split_pending: the shared account rows need an account-scope grant, not a project grant', async () => {
    expect((await authorize(actorForUser(people.admin, LEGACY_ACCOUNT), 'workspace.billing.read', ws(LEGACY_B))).allowed).toBe(true);
    // A manager of project A holds no grant on project B, so not on the shared billing row either.
    expect((await authorize(actorForUser(people.manager, LEGACY_ACCOUNT), 'workspace.member.invite', ws(LEGACY_A))).allowed).toBe(false);
  });

  test('a workspace of another account is never reached, even by that person’s owner role elsewhere', async () => {
    // The owner of ONE_ACCOUNT, resolved for ONE_ACCOUNT, asks about a legacy workspace.
    expect(await authorize(actorForUser(people.owner, ONE_ACCOUNT), 'workspace.read', ws(LEGACY_A))).toEqual({
      allowed: false,
      reason: 'no_project_membership',
    });
    // An unknown workspace id.
    expect(await authorize(actorForUser(people.owner, ONE_ACCOUNT), 'workspace.read', ws(uid()))).toEqual({
      allowed: false,
      reason: 'no_project_membership',
    });
  });
});

describe('one agent wall: HUMAN_ONLY (an inherited session acts as its person otherwise)', () => {
  const SA = uid();
  const AGENT_TOKEN = uid();
  const PLAIN_TOKEN = uid();
  // A My Kortix-shaped session token: a session and an agent grant, no service
  // account (mintSessionToken mints the coordinator this way, and any session
  // whose ensureAgentServiceAccount failed). The credential reads as a PAT.
  const NO_SA_SESSION_TOKEN = uid();

  beforeAll(async () => {
    await db.insert(serviceAccounts).values({
      serviceAccountId: SA,
      accountId: ONE_ACCOUNT,
      name: 'agent-test',
      secretHash: `h_${SA.slice(0, 8)}`,
      publicPrefix: `pp_${SA.slice(0, 8)}`,
      projectId: ONE_WS,
    });
    await db.insert(accountTokens).values([
      // An ungoverned session token (no agent grant): it authorizes as its launcher, the owner.
      {
        tokenId: AGENT_TOKEN, accountId: ONE_ACCOUNT, userId: people.owner, name: 'session',
        publicKey: `pk_a_${AGENT_TOKEN.slice(0, 8)}`, secretKeyHash: `h_a_${AGENT_TOKEN.slice(0, 8)}`,
        projectId: ONE_WS, sessionId: uid(), serviceAccountId: SA,
      },
      {
        tokenId: NO_SA_SESSION_TOKEN, accountId: ONE_ACCOUNT, userId: people.owner, name: 'my-kortix',
        publicKey: `pk_m_${NO_SA_SESSION_TOKEN.slice(0, 8)}`, secretKeyHash: `h_m_${NO_SA_SESSION_TOKEN.slice(0, 8)}`,
        projectId: ONE_WS, sessionId: uid(), agentGrant: myKortixAgentGrant(),
      },
      // The same person's project PAT.
      {
        tokenId: PLAIN_TOKEN, accountId: ONE_ACCOUNT, userId: people.owner, name: 'pat',
        publicKey: `pk_p_${PLAIN_TOKEN.slice(0, 8)}`, secretKeyHash: `h_p_${PLAIN_TOKEN.slice(0, 8)}`,
        projectId: ONE_WS,
      },
    ]);
  });

  const agentActor = (): Actor => ({
    userId: people.owner,
    accountId: ONE_ACCOUNT,
    credential: {
      kind: 'agent_session',
      tokenId: AGENT_TOKEN,
      projectId: ONE_WS,
      sessionId: null,
      agentGrant: null,
      serviceAccountId: SA,
      activated: false,
      agentPrincipal: false,
    },
    ctx: {},
  });
  const patActor = (): Actor => ({
    userId: people.owner,
    accountId: ONE_ACCOUNT,
    credential: { kind: 'pat', tokenId: PLAIN_TOKEN, projectId: ONE_WS },
    ctx: {},
  });

  test('the agent session keeps the launcher’s ordinary work', async () => {
    for (const action of ['workspace.read', 'workspace.write', 'workspace.session.start', 'project.gitops.push']) {
      expect((await authorize(agentActor(), action, ws(ONE_WS))).allowed).toBe(true);
    }
  });

  test('the inherited session administers the workspace as its person: members, budget (K1)', async () => {
    for (const action of ['workspace.members.manage', 'project.members.manage', 'workspace.gateway.budget.set']) {
      expect({ action, allowed: (await authorize(agentActor(), action, ws(ONE_WS))).allowed }).toEqual({ action, allowed: true });
    }
    // The workspace's own account surface is in scope for its bound token.
    for (const action of ['workspace.billing.read', 'workspace.member.invite', 'workspace.group.read']) {
      expect((await authorize(agentActor(), action)).allowed).toBe(true);
    }
  });

  test('HUMAN_ONLY is refused to the agent session, whatever the launcher holds', async () => {
    for (const action of ['workspace.delete', 'workspace.gateway.keys.manage', 'workspace.credentials.issue']) {
      expect({ action, ...(await authorize(agentActor(), action, ws(ONE_WS))) }).toEqual({
        action,
        allowed: false,
        reason: 'agent_human_only_action',
      });
    }
    for (const action of ['workspace.token.create', 'workspace.billing.write', 'workspace.account.delete']) {
      expect({ action, ...(await authorize(agentActor(), action)) }).toEqual({ action, allowed: false, reason: 'agent_human_only_action' });
    }
  });

  test('HUMAN_ONLY is refused to a session token that names no service account (My Kortix)', async () => {
    const credential = await tokenCredential(NO_SA_SESSION_TOKEN, ONE_ACCOUNT, null);
    const actor: Actor = { userId: people.owner, accountId: ONE_ACCOUNT, credential, ctx: {} };
    for (const action of ['workspace.delete', 'workspace.credentials.issue']) {
      expect({ action, ...(await authorize(actor, action, ws(ONE_WS))) }).toEqual({ action, allowed: false, reason: 'agent_human_only_action' });
    }
    for (const action of ['workspace.token.create', 'workspace.billing.write']) {
      expect({ action, ...(await authorize(actor, action)) }).toEqual({ action, allowed: false, reason: 'agent_human_only_action' });
    }
    // Its ordinary work still passes as the launcher.
    expect((await authorize(actor, 'workspace.write', ws(ONE_WS))).allowed).toBe(true);
  });

  test("a workspace-bound token never reaches another account's surface", async () => {
    const otherAccount = { ...agentActor(), accountId: LEGACY_ACCOUNT };
    expect((await authorize(otherAccount, 'workspace.member.read')).allowed).toBe(false);
  });

  test('a human project PAT of the same owner keeps workspace administration', async () => {
    expect((await authorize(patActor(), 'workspace.members.manage', ws(ONE_WS))).allowed).toBe(true);
  });
});
