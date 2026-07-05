/**
 * Integration test (real local DB): per-resource scoping (iam_resource_grants) —
 * "Marketing may use agent outreach-bot, nothing else". Sits as an INTERSECTION
 * on top of the project-role verdict:
 *   - an UNSCOPED agent (no grants) stays project-wide (no lockout)
 *   - a SCOPED agent (>=1 grant) is usable ONLY by granted principals
 *   - account owner/admin bypass scoping (implicit Editor (top project role))
 *   - adding a grant takes effect immediately (upsert busts the resource memo)
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { authorizeV2 } from '../iam/engine-v2';
import { PROJECT_ACTIONS, upsertResourceGrant } from '../iam';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const uid = () => crypto.randomUUID();

const SCOPED_AGENT = 'outreach-bot';
const OPEN_AGENT = 'general-bot';

// SESSION_START is in the 'user' baseline, so the base verdict passes for any
// project member — isolating the per-RESOURCE fold as the thing under test.
const onAgent = (agent: string) => ({ type: 'project' as const, id: PROJECT, resource: { type: 'agent' as const, id: agent } });
const canUse = async (userId: string, agent: string) =>
  (await authorizeV2(userId, ACCOUNT, PROJECT_ACTIONS.PROJECT_SESSION_START, onAgent(agent))).allowed;

async function seedMember(role: 'owner' | 'admin' | 'member') {
  const userId = uid();
  await db.insert(accountMembers).values({ userId, accountId: ACCOUNT, accountRole: role });
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
    await db.insert(projectMembers).values({ accountId: ACCOUNT, projectId: PROJECT, userId: alice, projectRole: 'editor' });
    const bob = await seedMember('member');
    await db.insert(projectMembers).values({ accountId: ACCOUNT, projectId: PROJECT, userId: bob, projectRole: 'editor' });

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
    expect((await authorizeV2(bob, ACCOUNT, PROJECT_ACTIONS.PROJECT_SESSION_START, onAgent(SCOPED_AGENT))).reason).toBe(
      'resource_scope_insufficient',
    );
  });

  test('granting the scoped agent to a member lets them in immediately', async () => {
    const carol = await seedMember('member');
    await db.insert(projectMembers).values({ accountId: ACCOUNT, projectId: PROJECT, userId: carol, projectRole: 'editor' });
    // SCOPED_AGENT was scoped (to Alice) in the previous test → Carol is out.
    expect(await canUse(carol, SCOPED_AGENT)).toBe(false);

    await upsertResourceGrant({
      accountId: ACCOUNT, projectId: PROJECT, resourceType: 'agent', resourceId: SCOPED_AGENT,
      principalType: 'member', principalId: carol, grantedBy: carol,
    });
    expect(await canUse(carol, SCOPED_AGENT)).toBe(true); // upsert busted the resource memo
  });

  test('account owner bypasses per-resource scoping (implicit Editor (top project role))', async () => {
    const owner = await seedMember('owner');
    // No project grant, no resource grant — still allowed on the scoped agent.
    expect(await canUse(owner, SCOPED_AGENT)).toBe(true);
  });
});
