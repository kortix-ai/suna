/**
 * Integration test (real local DB): two reliability guarantees the survey flagged
 * as e2e-untested —
 *   (1) a PROJECT-SCOPED token (PAT/session bound to a project) can act ONLY on
 *       that project and never on account-level actions, and
 *   (2) a time-bounded grant (project_members.expires_at) is IGNORED once past —
 *       filtered at authorization time, independent of the expiry sweeper.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountMembers, accountTokens, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { authorize } from '../iam/authorize';
import { actorForToken, actorForUser } from '../iam/actor';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam';

const ACCOUNT = crypto.randomUUID();
const P1 = crypto.randomUUID();
const P2 = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const SCOPED_TOKEN = crypto.randomUUID();
const UNSCOPED_TOKEN = crypto.randomUUID();
const uid = () => crypto.randomUUID();
const proj = (id: string) => ({ type: 'project' as const, id });

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'token-scope-test' });
  await db.insert(projects).values([
    { projectId: P1, accountId: ACCOUNT, name: 'p1', repoUrl: 'https://example.com/p1.git' },
    { projectId: P2, accountId: ACCOUNT, name: 'p2', repoUrl: 'https://example.com/p2.git' },
  ]);
  await db.insert(accountMembers).values({ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' });
  await db.insert(accountTokens).values([
    // A project-scoped token (sandbox/session or project PAT), bound to P1.
    { tokenId: SCOPED_TOKEN, accountId: ACCOUNT, userId: OWNER, name: 'scoped', publicKey: `pk_s_${SCOPED_TOKEN.slice(0, 8)}`, secretKeyHash: `h_s_${SCOPED_TOKEN.slice(0, 8)}`, projectId: P1 },
    // An account-wide PAT (no project binding).
    { tokenId: UNSCOPED_TOKEN, accountId: ACCOUNT, userId: OWNER, name: 'unscoped', publicKey: `pk_u_${UNSCOPED_TOKEN.slice(0, 8)}`, secretKeyHash: `h_u_${UNSCOPED_TOKEN.slice(0, 8)}`, projectId: null },
  ]);
});
afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades tokens/members
});

describe('token project-scope', () => {
  test('a project-bound token acts ONLY on its project — never another project or account actions', async () => {
    // In scope: its own project.
    expect((await authorize(await actorForToken(OWNER, ACCOUNT, SCOPED_TOKEN), PROJECT_ACTIONS.PROJECT_READ, proj(P1))).allowed).toBe(true);
    // Another project → out of scope (even though the OWNER could otherwise).
    const otherProj = await authorize(await actorForToken(OWNER, ACCOUNT, SCOPED_TOKEN), PROJECT_ACTIONS.PROJECT_READ, proj(P2));
    expect(otherProj.allowed).toBe(false);
    expect(otherProj.reason).toBe('token_out_of_scope');
    // Account-level action → out of scope.
    const acct = await authorize(await actorForToken(OWNER, ACCOUNT, SCOPED_TOKEN), ACCOUNT_ACTIONS.MEMBER_READ);
    expect(acct.allowed).toBe(false);
    expect(acct.reason).toBe('token_out_of_scope');
  });

  test('an unscoped account PAT is not project-restricted', async () => {
    expect((await authorize(await actorForToken(OWNER, ACCOUNT, UNSCOPED_TOKEN), PROJECT_ACTIONS.PROJECT_READ, proj(P2))).allowed).toBe(true);
    expect((await authorize(await actorForToken(OWNER, ACCOUNT, UNSCOPED_TOKEN), ACCOUNT_ACTIONS.MEMBER_READ)).allowed).toBe(true);
  });
});

describe('grant expiry (filtered at authorization time)', () => {
  test('an EXPIRED project grant is ignored; a FUTURE-dated one still applies', async () => {
    const expired = uid();
    await db.insert(accountMembers).values({ userId: expired, accountId: ACCOUNT, accountRole: 'member' });
    await db.insert(projectMembers).values({
      accountId: ACCOUNT, projectId: P1, userId: expired, projectRole: 'manager',
      expiresAt: new Date(Date.now() - 60_000), // one minute ago
    });
    expect((await authorize(actorForUser(expired, ACCOUNT), PROJECT_ACTIONS.PROJECT_WRITE, proj(P1))).allowed).toBe(false);

    const future = uid();
    await db.insert(accountMembers).values({ userId: future, accountId: ACCOUNT, accountRole: 'member' });
    await db.insert(projectMembers).values({
      accountId: ACCOUNT, projectId: P1, userId: future, projectRole: 'manager',
      expiresAt: new Date(Date.now() + 3_600_000), // one hour out
    });
    expect((await authorize(actorForUser(future, ACCOUNT), PROJECT_ACTIONS.PROJECT_WRITE, proj(P1))).allowed).toBe(true);
  });
});
