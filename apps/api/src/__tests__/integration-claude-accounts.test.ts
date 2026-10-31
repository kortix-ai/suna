// Which Claude account the gateway uses for Claude Code's model calls
// (`resolveClaudeCredentials`): the session's selected accounts, else the
// personal-key owner's own, else one shared with the project. A private account
// serves only its creator; a refused one is skipped.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { accountMembers, accountSecretResources, accounts, projectSessions, projects, sessionProviderSecretPools } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { CLAUDE_ACCOUNT, claudeCredentialsForGateway, countUsableClaudeAccounts, markClaudeAccountRefused, resolveClaudeCredentials } from '../claude-subscription/accounts';
import { writeProviderAccount } from '../secrets/provider-accounts';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = randomUUID();
const PROJECT = randomUUID();
const OWNER = randomUUID();
const OTHER = randomUUID();
const SESSION = randomUUID();
const OWN = randomUUID();
const SHARED = randomUUID();
const SELECTED = randomUUID();
const token = (name: string) => `sk-ant-oat01-${name.padEnd(40, 'x')}`;

const principal = (personalUserId: string | null, extra: { sessionId?: string; userId?: string } = {}) => ({
  accountId: ACCOUNT, projectId: PROJECT, userId: extra.userId ?? OWNER, sessionId: extra.sessionId ?? null, personalUserId,
});
const ids = async (p: ReturnType<typeof principal>) => (await resolveClaudeCredentials(p)).map((credential) => credential.secretId);

beforeAll(async () => {
  for (const user of [OWNER, OTHER]) {
    await db.execute(sql`insert into auth.users (id, email) values (${user}, ${`claude-accounts-${user.slice(0, 8)}@example.test`})`);
  }
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'claude-accounts' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'claude-accounts', repoUrl: 'https://example.test/claude-accounts.git' });
  for (const user of [OWNER, OTHER]) await insertIntoView(db, accountMembers, { userId: user, accountId: ACCOUNT, accountRole: 'owner' });
  await db.insert(projectSessions).values({ sessionId: SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: SESSION, createdBy: OWNER, visibility: 'private' });
  const base = { accountId: ACCOUNT, projectId: PROJECT, kind: CLAUDE_ACCOUNT };
  await writeProviderAccount({ ...base, secretId: OWN, userId: OWNER, label: 'Mine', value: token('own'), sharing: { mode: 'private', ownerId: OWNER } });
  await writeProviderAccount({ ...base, secretId: SHARED, userId: OTHER, label: 'Team', value: token('shared'), sharing: { mode: 'project' } });
  await writeProviderAccount({ ...base, secretId: SELECTED, userId: OTHER, label: 'Selected', value: token('selected'), sharing: { mode: 'project' } });
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`delete from auth.users where id in (${OWNER}, ${OTHER})`);
});

describe('the Claude account a request uses', () => {
  test('the personal-key owner uses their own private account first', async () => {
    expect(await ids(principal(OWNER))).toEqual([OWN]);
    expect((await resolveClaudeCredentials(principal(OWNER)))[0]!.token).toBe(token('own'));
  });

  test("a member's own newest account serves them; a shared session or an unattended run gets only the accounts shared with the project", async () => {
    // OTHER created both shared accounts: their own newest one serves them.
    expect(await ids(principal(OTHER, { userId: OTHER }))).toEqual([SELECTED]);
    // No personal-key owner: the private account of OWNER never serves, the shared ones rotate oldest first.
    expect(await ids(principal(null))).toEqual([SHARED, SELECTED]);
    expect(await countUsableClaudeAccounts(ACCOUNT, PROJECT, OWNER)).toBe(3);
  });

  test("a session's selected accounts win over the owner's own", async () => {
    await db.insert(sessionProviderSecretPools).values({ sessionId: SESSION, providerId: 'claude-agent', secretIds: [SELECTED], updatedAt: new Date() });
    expect(await ids(principal(OWNER, { sessionId: SESSION }))).toEqual([SELECTED]);
    await db.delete(sessionProviderSecretPools).where(eq(sessionProviderSecretPools.sessionId, SESSION));
  });

  test('a refused account is marked only for its current token, then skipped for a shared one', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(await markClaudeAccountRefused(ACCOUNT, OWN, digest('an older token'))).toBe(false);
    expect(await markClaudeAccountRefused(ACCOUNT, OWN, digest(token('own')))).toBe(true);
    expect(await ids(principal(OWNER))).toEqual([SHARED, SELECTED]);
    await db.update(accountSecretResources).set({ needsReauthAt: null }).where(eq(accountSecretResources.secretId, OWN));
  });

  test('the gateway answer: tokens to try, the provider turned off, or no account', async () => {
    const found = await claudeCredentialsForGateway(principal(OWNER), 'claude-sonnet-5-5');
    expect(found).toEqual({ credentials: [{ secretId: OWN, apiKey: token('own') }] });
    // One model off: the picker and the session model change refuse it, the
    // passthrough does not (Claude Code calls a smaller model on its own).
    await db.update(projects).set({ metadata: { model_access: { disabledProviders: [], disabledModels: ['claude-agent/haiku'] } } }).where(eq(projects.projectId, PROJECT));
    const oneOff = await claudeCredentialsForGateway(principal(OWNER), 'claude-haiku-5-5');
    expect('credentials' in oneOff).toBe(true);
    await db.update(projects).set({ metadata: { model_access: { disabledProviders: ['claude-agent'], disabledModels: [] } } }).where(eq(projects.projectId, PROJECT));
    const off = await claudeCredentialsForGateway(principal(OWNER), 'claude-sonnet-5-5-20261001');
    expect('error' in off && off.error.code).toBe('provider_disabled');
    expect('error' in off && off.error.status).toBe(403);
    await db.update(projects).set({ metadata: {} }).where(eq(projects.projectId, PROJECT));
    await db.delete(accountSecretResources).where(eq(accountSecretResources.accountId, ACCOUNT));
    const none = await claudeCredentialsForGateway(principal(null), 'claude-opus-5-5');
    expect('error' in none && none.error.code).toBe('provider_not_connected');
  });
});
