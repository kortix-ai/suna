// Whose Claude subscription a session's box gets (`claudeTokenForSession`): the
// person the session's live token acts for. A My Kortix session's token is the
// owner's own (no service account) and still names that owner; an unattended
// run names nobody and gets no login.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accountTokens, accounts, projectSessions, projects, serviceAccounts } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { claudeTokenForSession, saveClaudeLogin, sessionPerson } from '../claude-subscription/store';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const AGENT_SA = crypto.randomUUID();
const MY_KORTIX = crypto.randomUUID();
const AGENT_PROMPTED = crypto.randomUUID();
const UNATTENDED = crypto.randomUUID();
const TOKEN = `sk-ant-oat01-${'a'.repeat(40)}`;

const token = (sessionId: string, serviceAccountId: string | null, onBehalfOfUserId: string | null) => ({
  accountId: ACCOUNT, userId: OWNER, name: `session ${sessionId}`, projectId: PROJECT, sessionId,
  serviceAccountId, onBehalfOfUserId,
  publicKey: `pk_${sessionId.slice(0, 12)}`, secretKeyHash: `h_${sessionId}`,
  agentGrant: { agent: 'kortix', permissions: 'all', connectors: 'all', env: 'all' },
});

beforeAll(async () => {
  // `on_behalf_of_user_id` and the account membership reference a real user.
  await db.execute(sql`insert into auth.users (id, email) values (${OWNER}, ${`claude-person-${OWNER.slice(0, 8)}@example.test`})`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'claude-person' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'claude-person', repoUrl: 'https://example.test/claude-person.git' });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' });
  await db.insert(serviceAccounts).values({
    serviceAccountId: AGENT_SA, accountId: ACCOUNT, name: `agent-${AGENT_SA}`,
    secretHash: `sa-${AGENT_SA}`, publicPrefix: 'kortix_sa_claude', createdBy: OWNER,
  });
  await db.insert(projectSessions).values([MY_KORTIX, AGENT_PROMPTED, UNATTENDED].map((sessionId) => ({
    sessionId, accountId: ACCOUNT, projectId: PROJECT, branchName: sessionId, createdBy: OWNER, visibility: 'private' as const,
  })));
  await db.insert(accountTokens).values([
    // My Kortix: the owner's own token, no service account.
    token(MY_KORTIX, null, OWNER),
    // An agent's token while a person prompts it.
    token(AGENT_PROMPTED, AGENT_SA, OWNER),
    // A trigger run: the agent acts for nobody.
    token(UNATTENDED, AGENT_SA, null),
  ]);
  await saveClaudeLogin(ACCOUNT, OWNER, TOKEN, 'pasted');
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`delete from auth.users where id = ${OWNER}`);
});

describe('the Claude login a session box gets', () => {
  test('a My Kortix session gets its owner login, though its token has no service account', async () => {
    expect(await sessionPerson(MY_KORTIX)).toBe(OWNER);
    expect(await claudeTokenForSession(PROJECT, MY_KORTIX)).toBe(TOKEN);
  });

  test('an agent session gets the login of the person it acts for', async () => {
    expect(await claudeTokenForSession(PROJECT, AGENT_PROMPTED)).toBe(TOKEN);
  });

  test('an unattended run gets no login', async () => {
    expect(await sessionPerson(UNATTENDED)).toBeNull();
    expect(await claudeTokenForSession(PROJECT, UNATTENDED)).toBeNull();
  });
});
