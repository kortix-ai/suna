/**
 * Integration test (real local DB): per-resource scoping (iam_resource_grants) —
 * "Marketing may use agent outreach-bot, nothing else". Sits as an INTERSECTION
 * on top of the project-role verdict:
 *   - an UNSCOPED agent (no grants) stays project-wide (no lockout)
 *   - a SCOPED agent (>=1 grant) is usable ONLY by granted principals
 *   - account owner/admin bypass scoping (implicit Manager)
 *   - adding a grant takes effect immediately (upsert busts the resource memo)
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { authorize, filterAccessibleObjects } from '../iam/authorize';
import { actorForUser } from '../iam/actor';
import { PROJECT_ACTIONS, upsertResourceGrant } from '../iam';
import { assignRole, SYSTEM_ACTOR } from '../iam/assignments';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const uid = () => crypto.randomUUID();

const SCOPED_AGENT = 'outreach-bot';
const OPEN_AGENT = 'general-bot';

// SESSION_START is in the 'user' baseline, so the base verdict passes for any
// project member — isolating the per-RESOURCE fold as the thing under test.
const onAgent = (agent: string) => ({ type: 'project' as const, id: PROJECT, resource: { type: 'agent' as const, id: agent } });
const canUse = async (userId: string, agent: string) =>
  (await authorize(actorForUser(userId, ACCOUNT), PROJECT_ACTIONS.PROJECT_SESSION_START, onAgent(agent))).allowed;

async function seedMember(role: 'owner' | 'admin' | 'member') {
  const userId = uid();
  await insertIntoView(db, accountMembers, { userId, accountId: ACCOUNT, accountRole: role });
  return userId;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'resource-scope-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' });
});
afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('per-resource scoping (iam_resource_grants)', () => {
  test('scoping one agent restricts ONLY that agent; unscoped agents stay open', async () => {
    const alice = await seedMember('member');
    await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: alice, projectRole: 'manager' });
    const bob = await seedMember('member');
    await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: bob, projectRole: 'manager' });

    // Before any grant: both agents are unscoped → both members can use both.
    expect(await canUse(alice, SCOPED_AGENT)).toBe(true);
    expect(await canUse(bob, SCOPED_AGENT)).toBe(true);

    // Scope SCOPED_AGENT to Alice only.
    await upsertResourceGrant({
      accountId: ACCOUNT, projectId: PROJECT, resourceType: 'agent', resourceId: SCOPED_AGENT,
      principalType: 'member', principalId: alice, grantedBy: alice,
    });

    // Now SCOPED_AGENT is usable only by Alice; Bob is scoped out. OPEN_AGENT (no
    // grant) stays project-wide for both.
    expect(await canUse(alice, SCOPED_AGENT)).toBe(true);
    expect(await canUse(bob, SCOPED_AGENT)).toBe(false);
    expect(await canUse(alice, OPEN_AGENT)).toBe(true);
    expect(await canUse(bob, OPEN_AGENT)).toBe(true);
    expect((await authorize(actorForUser(bob, ACCOUNT), PROJECT_ACTIONS.PROJECT_SESSION_START, onAgent(SCOPED_AGENT))).reason).toBe(
      'resource_scope_insufficient',
    );
  });

  test('granting the scoped agent to a member lets them in immediately', async () => {
    const carol = await seedMember('member');
    await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: carol, projectRole: 'manager' });
    // SCOPED_AGENT was scoped (to Alice) in the previous test → Carol is out.
    expect(await canUse(carol, SCOPED_AGENT)).toBe(false);

    await upsertResourceGrant({
      accountId: ACCOUNT, projectId: PROJECT, resourceType: 'agent', resourceId: SCOPED_AGENT,
      principalType: 'member', principalId: carol, grantedBy: carol,
    });
    expect(await canUse(carol, SCOPED_AGENT)).toBe(true); // upsert busted the resource memo
  });

  test('a grant to everyone in the project reaches every project member, and nobody else', async () => {
    const AGENT = 'everyone-bot';
    const dave = await seedMember('member');
    await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: dave, projectRole: 'member' });
    // An account member with no project role is not "in the project".
    const outsider = await seedMember('member');

    // Agents are closed to the member tier until someone grants them.
    expect(await canUse(dave, AGENT)).toBe(false);

    await assignRole(SYSTEM_ACTOR, ACCOUNT, {
      principal: { type: 'project', id: PROJECT },
      roleKey: 'agent-user',
      scope: { type: 'project', id: PROJECT },
      object: { type: 'agent', id: AGENT },
    });

    expect(await canUse(dave, AGENT)).toBe(true);
    expect(await canUse(outsider, AGENT)).toBe(false);

    // The pickers' list form answers the same: the Slack and Teams agent lists
    // must not name the agent to an account member outside the project.
    const listed = (userId: string) => filterAccessibleObjects(actorForUser(userId, ACCOUNT), PROJECT, 'agent', [AGENT]);
    expect(await listed(dave)).toEqual([AGENT]);
    expect(await listed(outsider)).toEqual([]);
  });

  test('account owner bypasses per-resource scoping (implicit Manager)', async () => {
    const owner = await seedMember('owner');
    // No project grant, no resource grant — still allowed on the scoped agent.
    expect(await canUse(owner, SCOPED_AGENT)).toBe(true);
  });
});
