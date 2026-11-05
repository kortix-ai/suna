// Which Claude account the gateway uses for Claude Code's model calls
// (`resolveClaudeCredentials`): the session's selected accounts, else the
// personal-key owner's own, else one shared with the project. A private account
// serves only its creator; a refused one is skipped.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { accountMembers, accountSecretResources, accounts, projectSessions, projects, sessionProviderSecretPools } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { CLAUDE_ACCOUNT, claudeCredentialsForGateway, countUsableClaudeAccounts, markClaudeAccountRefused, resolveClaudeCredentials } from '../claude-subscription/accounts';
import { coolDownAccountSecret } from '../secrets/account-resource';
import { writeProviderAccount } from '../secrets/provider-accounts';
import { isModelServableForAccount } from '../llm-gateway/resolution/default-model';
import { resolveCandidates } from '../llm-gateway/resolution/resolve-candidates';
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

  test('a session stays on one account across calls, moves when its usage runs out, and a probe never moves it', async () => {
    const usage = (percent: number, limited = false) => ({
      windows: [{ id: 'weekly', window_minutes: 10080, used_percent: percent, resets_at: new Date(Date.now() + 86_400_000).toISOString() }],
      limited, observed_at: new Date().toISOString(), source: 'response',
    });
    const setUsage = (secretId: string, value: unknown) =>
      db.update(accountSecretResources).set({ usage: value }).where(eq(accountSecretResources.secretId, secretId));
    const pin = async () => {
      const [row] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions).where(eq(projectSessions.sessionId, SESSION));
      return (row?.metadata as { provider_account_pins?: Record<string, string> } | null)?.provider_account_pins?.['claude-agent'];
    };
    // An earlier test's call pinned this session already: start it fresh.
    await db.update(projectSessions).set({ metadata: {} }).where(eq(projectSessions.sessionId, SESSION));
    // Selected accounts used to rotate on every call; now the session keeps the first it got.
    await db.insert(sessionProviderSecretPools).values({ sessionId: SESSION, providerId: 'claude-agent', secretIds: [SHARED, SELECTED], updatedAt: new Date() });
    const session = principal(null, { sessionId: SESSION });
    for (let call = 0; call < 4; call++) expect((await ids(session))[0]).toBe(SHARED);
    expect(await pin()).toBe(SHARED);

    // Its account nears the end of the week: the session moves to the one with room, and stays.
    await setUsage(SHARED, usage(97));
    expect(await ids(session)).toEqual([SELECTED, SHARED]);
    expect(await pin()).toBe(SELECTED);
    await setUsage(SHARED, usage(5));
    expect((await ids(session))[0]).toBe(SELECTED);

    // A probe (turn gate, picker) reads the order and never moves the session.
    await setUsage(SELECTED, usage(40, true));
    expect((await resolveClaudeCredentials(session, { probe: true }))[0]!.secretId).toBe(SHARED);
    expect(await pin()).toBe(SELECTED);
    // The next real call leaves the limited account.
    expect((await ids(session))[0]).toBe(SHARED);
    expect(await pin()).toBe(SHARED);

    // Shared accounts of a session without a selection are sticky the same way.
    await db.delete(sessionProviderSecretPools).where(eq(sessionProviderSecretPools.sessionId, SESSION));
    await setUsage(SELECTED, null);
    await setUsage(SHARED, usage(96));
    expect((await ids(session))[0]).toBe(SELECTED);
    await setUsage(SHARED, null);
    expect((await ids(session))[0]).toBe(SELECTED);

    await db.update(projectSessions).set({ metadata: {} }).where(eq(projectSessions.sessionId, SESSION));
  });

  test("a session's Claude step sent to the gateway while every Claude account rests is a resting pool, so the project's chain serves it", async () => {
    const session = { ...principal(null), sessionId: SESSION };
    const refusal = async () => resolveCandidates(session, 'claude-agent/opus').then(() => null, (err: { code?: string; restSeconds?: number }) => err);
    const servable = (restingIsServable?: boolean) => isModelServableForAccount({
      accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, sessionId: SESSION, personalUserId: null, freeModelsOnly: false,
      model: 'claude-agent/opus', restingIsServable,
    });
    // An account has room: the gateway still cannot run Claude Code.
    expect((await refusal())?.code).toBe('model_not_found');
    expect(await servable(false)).toBe(true);

    for (const secretId of [SHARED, SELECTED]) await coolDownAccountSecret(secretId, ACCOUNT, 3 * 3600);
    const resting = await refusal();
    expect(resting?.code).toBe('provider_pool_rate_limited');
    expect(resting?.restSeconds).toBeGreaterThan(3 * 3600 - 60);
    // The fallback stays until an account has room; a turn gate still lets the person try.
    expect(await servable(false)).toBe(false);
    expect(await servable()).toBe(true);

    await db.update(accountSecretResources).set({ cooldownUntil: null, cooldownProbeAt: null }).where(eq(accountSecretResources.accountId, ACCOUNT));
    expect(await servable(false)).toBe(true);
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
