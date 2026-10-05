/**
 * Integration test (real local DB): the pooled gateway-key reads in
 * secrets/account-resource.ts, the SQL every pool decision uses.
 *
 * - `queryUsableGatewaySecrets` checks keys only: provider, exact key name,
 *   ids, project scope, and the grants of one `grantUserId`.
 * - `listUsableGatewaySecrets` adds the member gate: its `userId` must read
 *   the project and have an `account_members` row.
 * - `resolveProjectSharedProviderSecrets` is the same member-gated read with
 *   values: the ChatGPT accounts an unconfigured session falls back to.
 *
 * Fully isolated: a fresh account, two projects, members and keys seeded here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accountSecretGrants, accountSecretResources, accounts, projectMembers } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  coolDownAccountSecret, encryptAccountSecret, listUsableGatewaySecrets, memberMayReadProject, queryUsableGatewaySecrets,
  resolveProjectSharedProviderSecrets,
} from '../secrets/account-resource';
import { mayUseProviderKeys, providerEnvVarOf } from '../secrets/provider-key-selection';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const NAME = 'ANTHROPIC_API_KEY';
/** Reads the project, holds grants. */
const GRANTEE = crypto.randomUUID();
/** Reads the project, holds no grant. */
const READER = crypto.randomUUID();
/** An account member with no project role: cannot read the project. */
const OUTSIDER = crypto.randomUUID();
/** No `account_members` row. */
const STRANGER = crypto.randomUUID();

let project: SeededProject;
let otherProject: SeededProject;
let accountId: string;
let projectId: string;
const key: Record<string, string> = {};

async function seedKey(label: string, over: Partial<typeof accountSecretResources.$inferInsert> = {}): Promise<string> {
  const [row] = await db.insert(accountSecretResources).values({
    accountId,
    projectId,
    label,
    accessMode: 'project',
    providerId: 'anthropic',
    name: NAME,
    valueEnc: 'encrypted-test-value',
    consumer: 'llm_gateway',
    strategy: 'runtime',
    createdBy: GRANTEE,
    // Distinct creation times fix the oldest-first order.
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, Object.keys(key).length)),
    ...over,
  }).returning({ secretId: accountSecretResources.secretId });
  key[label] = row!.secretId;
  return row!.secretId;
}

const ids = (rows: Array<{ secretId: string }>) => rows.map((row) => row.secretId);
const labels = (rows: Array<{ label: string }>) => rows.map((row) => row.label);

beforeAll(async () => {
  project = await seedProject('usable-gateway-secrets');
  accountId = project.account_id;
  projectId = project.project_id;
  otherProject = await seedProject('usable-gateway-secrets-other', { accountId });
  await insertIntoView(db, accountMembers, [
    { userId: GRANTEE, accountId, accountRole: 'member', isSuperAdmin: false },
    { userId: READER, accountId, accountRole: 'member', isSuperAdmin: false },
    { userId: OUTSIDER, accountId, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId, projectId, userId: GRANTEE, projectRole: 'member' },
    { accountId, projectId, userId: READER, projectRole: 'member' },
  ]);

  await seedKey('project');
  await seedKey('account-wide', { projectId: null });
  await seedKey('granted', { accessMode: 'members' });
  await seedKey('ungranted', { accessMode: 'members' });
  await seedKey('longer-name', { name: `${NAME}_OLD` });
  await seedKey('lower-name', { name: NAME.toLowerCase() });
  await seedKey('other-project', { projectId: otherProject.project_id });
  await seedKey('inactive', { active: false });
  await seedKey('sandbox-consumer', { consumer: 'sandbox' });
  await seedKey('other-provider', { providerId: 'openai', name: 'OPENAI_API_KEY' });
  await db.insert(accountSecretGrants).values({ secretId: key.granted!, accountId, userId: GRANTEE, grantedBy: GRANTEE });
});

afterAll(async () => {
  await removeSeeded([otherProject, project]);
});

/**
 * An account that requires MFA. Account-wide MFA guards a person's own browser
 * requests (authorize step 6). A key lookup asks about a member, not as them.
 * Until 2026-10-01 it ran that gate with no MFA level, so every member except
 * a super admin read as "no". A Teams channel session in such an account then
 * never reached the ChatGPT login shared with the whole project: every turn
 * failed with "Connect Codex to use this model".
 */
describe('an account that requires MFA', () => {
  const MEMBER = crypto.randomUUID();
  const NO_ROLE = crypto.randomUUID();
  let mfa: SeededProject;
  let sharedLogin: string;

  beforeAll(async () => {
    // A fresh account, set to require MFA before anything authorizes in it.
    mfa = await seedProject('usable-gateway-secrets-mfa');
    await db.update(accounts).set({ mfaRequired: true }).where(eq(accounts.accountId, mfa.account_id));
    await insertIntoView(db, accountMembers, [
      { userId: MEMBER, accountId: mfa.account_id, accountRole: 'member', isSuperAdmin: false },
      { userId: NO_ROLE, accountId: mfa.account_id, accountRole: 'member', isSuperAdmin: false },
    ]);
    await insertIntoView(db, projectMembers, [
      { accountId: mfa.account_id, projectId: mfa.project_id, userId: MEMBER, projectRole: 'member' },
    ]);
    const [row] = await db.insert(accountSecretResources).values({
      accountId: mfa.account_id,
      projectId: mfa.project_id,
      label: 'shared with the project',
      accessMode: 'project',
      providerId: 'codex',
      name: 'CODEX_AUTH_JSON',
      valueEnc: encryptAccountSecret(mfa.account_id, JSON.stringify({ openai: { access: 'shared-token' } })),
      consumer: 'llm_gateway',
      strategy: 'runtime',
      createdBy: NO_ROLE,
    }).returning({ secretId: accountSecretResources.secretId });
    sharedLogin = row!.secretId;
  });

  afterAll(async () => {
    await removeSeeded([mfa]);
  });

  test('a member`s session still reaches the ChatGPT login shared with the project', async () => {
    const result = await resolveProjectSharedProviderSecrets({
      accountId: mfa.account_id, projectId: mfa.project_id, userId: MEMBER, grantUserId: null,
      providerId: 'codex', name: 'CODEX_AUTH_JSON',
    });
    expect(result.secrets.map((s) => s.secretId)).toEqual([sharedLogin]);
  });

  test('the role still decides: a member with no project role gets nothing', async () => {
    expect(await listUsableGatewaySecrets({
      accountId: mfa.account_id, projectId: mfa.project_id, userId: NO_ROLE, grantUserId: null, providerId: 'codex',
    })).toEqual([]);
  });

  test('a request about the caller themself keeps its MFA level: aal1 is refused, aal2 passes', async () => {
    expect(await memberMayReadProject(mfa.account_id, mfa.project_id, MEMBER, { mfaAal: 'aal1' })).toBe(false);
    expect(await memberMayReadProject(mfa.account_id, mfa.project_id, MEMBER, { mfaAal: undefined })).toBe(false);
    expect(await memberMayReadProject(mfa.account_id, mfa.project_id, MEMBER, { mfaAal: 'aal2' })).toBe(true);
  });
});

describe('queryUsableGatewaySecrets: keys only', () => {
  const q = (over: Partial<Parameters<typeof queryUsableGatewaySecrets>[0]> = {}) =>
    queryUsableGatewaySecrets({ accountId, projectId, grantUserId: GRANTEE, providerId: 'anthropic', name: NAME, ...over });

  test('an exact key-name match: a longer name or another case is a different key', async () => {
    expect(labels(await q())).toEqual(['project', 'account-wide', 'granted']);
  });

  test('without a name, every active llm_gateway key of the provider in scope, oldest first', async () => {
    expect(labels(await q({ name: undefined }))).toEqual(['project', 'account-wide', 'granted', 'longer-name', 'lower-name']);
  });

  test('the ids filter returns only the named keys, and never one out of scope', async () => {
    expect(labels(await q({ ids: [key.granted!, key.project!] }))).toEqual(['project', 'granted']);
    expect(await q({ ids: [key['other-project']!, key.inactive!, key['sandbox-consumer']!, key['longer-name']!] })).toEqual([]);
    expect(await q({ ids: [crypto.randomUUID()] })).toEqual([]);
  });

  test('a key granted to one member counts only for that grantUserId', async () => {
    expect(labels(await q({ grantUserId: READER }))).toEqual(['project', 'account-wide']);
    expect(labels(await q({ grantUserId: STRANGER }))).toEqual(['project', 'account-wide']);
  });

  test('grantUserId null is project-only scope: keys shared with the whole project', async () => {
    expect(labels(await q({ grantUserId: null }))).toEqual(['project', 'account-wide']);
  });

  test('no principal gate: a grantUserId that cannot read the project still reads project keys', async () => {
    // The route authorized whoever acts; this read checks keys, not people.
    expect(labels(await q({ grantUserId: OUTSIDER }))).toEqual(['project', 'account-wide']);
  });

  test('mayUseProviderKeys checks every id under the provider`s own key name', async () => {
    expect(providerEnvVarOf('anthropic')).toBe(NAME);
    const scope = { accountId, projectId, providerId: 'anthropic' };
    expect(await mayUseProviderKeys({ ...scope, grantUserId: GRANTEE, ids: [key.project!, key.granted!] })).toBe(true);
    expect(await mayUseProviderKeys({ ...scope, grantUserId: READER, ids: [key.project!, key.granted!] })).toBe(false);
    expect(await mayUseProviderKeys({ ...scope, grantUserId: null, ids: [key.project!, key['account-wide']!] })).toBe(true);
    expect(await mayUseProviderKeys({ ...scope, grantUserId: GRANTEE, ids: [key['longer-name']!] })).toBe(false);
  });
});

describe('listUsableGatewaySecrets: the member gate', () => {
  const list = (userId: string, grantUserId?: string | null) =>
    listUsableGatewaySecrets({ accountId, projectId, userId, grantUserId, providerId: 'anthropic', name: NAME });

  test('a member who reads the project gets its keys, with its own grants by default', async () => {
    expect(labels(await list(GRANTEE))).toEqual(['project', 'account-wide', 'granted']);
    expect(labels(await list(READER))).toEqual(['project', 'account-wide']);
  });

  test('the grant counts only for grantUserId, not for the member the keys are listed for', async () => {
    expect(labels(await list(GRANTEE, READER))).toEqual(['project', 'account-wide']);
    expect(labels(await list(GRANTEE, null))).toEqual(['project', 'account-wide']);
    expect(labels(await list(READER, GRANTEE))).toEqual(['project', 'account-wide', 'granted']);
  });

  test('a member who cannot read the project gets no key', async () => {
    expect(await list(OUTSIDER)).toEqual([]);
    expect(await list(OUTSIDER, null)).toEqual([]);
  });

  test('a principal with no account membership gets no key', async () => {
    expect(await list(STRANGER, null)).toEqual([]);
  });

  test('the ids filter narrows the member listing too', async () => {
    expect(ids(await listUsableGatewaySecrets({
      accountId, projectId, userId: GRANTEE, providerId: 'anthropic', name: NAME, ids: [key.granted!],
    }))).toEqual([key.granted!]);
  });
});

describe('resolveProjectSharedProviderSecrets: the ChatGPT accounts an unconfigured session falls back to', () => {
  const CODEX = 'CODEX_AUTH_JSON';
  const codex: Record<string, string> = {};
  let minute = 100;

  async function seedCodex(label: string, over: Partial<typeof accountSecretResources.$inferInsert> = {}) {
    const [row] = await db.insert(accountSecretResources).values({
      accountId,
      projectId,
      label,
      accessMode: 'project',
      providerId: 'codex',
      name: CODEX,
      valueEnc: encryptAccountSecret(accountId, JSON.stringify({ openai: { access: `${label}-token` } })),
      consumer: 'llm_gateway',
      strategy: 'runtime',
      // The CREATOR is GRANTEE: every read below is by someone else, or by nobody.
      createdBy: GRANTEE,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute++)),
      ...over,
    }).returning({ secretId: accountSecretResources.secretId });
    codex[label] = row!.secretId;
  }

  beforeAll(async () => {
    await seedCodex('team-oldest');
    await seedCodex('team-account-wide', { projectId: null });
    await seedCodex('team-cooling', { cooldownUntil: new Date(Date.now() + 60_000) });
    await seedCodex('restricted-ungranted', { accessMode: 'members' });
    await seedCodex('restricted-granted-reader', { accessMode: 'members' });
    await seedCodex('other-project', { projectId: otherProject.project_id });
    await seedCodex('inactive', { active: false });
    await db.insert(accountSecretGrants).values({
      secretId: codex['restricted-granted-reader']!, accountId, userId: READER, grantedBy: GRANTEE,
    });
  });

  const shared = (userId: string, grantUserId: string | null) =>
    resolveProjectSharedProviderSecrets({ accountId, projectId, userId, grantUserId, providerId: 'codex', name: CODEX });

  test('an agent-principal session (no personal owner) gets the project-shared accounts, oldest first, decrypted', async () => {
    const result = await shared(READER, null);
    expect(labels(result.secrets)).toEqual(['team-oldest', 'team-account-wide']);
    expect(result.secrets.map((s) => (s.value === null ? null : JSON.parse(s.value).openai.access)))
      .toEqual(['team-oldest-token', 'team-account-wide-token']);
    expect(result.coolingDown).toBe(false);
  });

  test('a member who did not create a shared account gets it, plus the restricted account granted to them', async () => {
    expect(labels((await shared(READER, READER)).secrets)).toEqual(['team-oldest', 'team-account-wide', 'restricted-granted-reader']);
  });

  test('a member-restricted account is never usable by a principal it is not granted to', async () => {
    for (const grantUserId of [null, GRANTEE, STRANGER]) {
      expect(labels((await shared(READER, grantUserId)).secrets)).not.toContain('restricted-ungranted');
      expect(labels((await shared(READER, grantUserId)).secrets)).not.toContain('restricted-granted-reader');
    }
  });

  test('a principal that cannot read the project, or is not an account member, gets nothing', async () => {
    expect(await shared(OUTSIDER, null)).toEqual({ coolingDown: false, secrets: [] });
    expect(await shared(STRANGER, null)).toEqual({ coolingDown: false, secrets: [] });
  });

  test('an account cooling down is skipped; when every usable account cools down, the earliest retry is reported', async () => {
    const onlyCooling = await resolveProjectSharedProviderSecrets({
      accountId, projectId, userId: READER, grantUserId: null, providerId: 'codex', name: CODEX,
      ids: [codex['team-cooling']!],
    });
    expect(onlyCooling.secrets).toEqual([]);
    expect(onlyCooling.coolingDown).toBe(true);
    expect(onlyCooling.retryAfterSeconds).toBeGreaterThan(0);
    expect(onlyCooling.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  // ChatGPT's weekly plan limit names its reset. The account rests until then;
  // a later, shorter limit from another replica never shortens the rest.
  test('a usage limit rests an account until its reset, and a shorter limit after it does not shorten it', async () => {
    await seedCodex('usage-limited', { projectId: otherProject.project_id });
    const id = codex['usage-limited']!;
    await coolDownAccountSecret(id, accountId, 414_374);
    await coolDownAccountSecret(id, accountId, 30);
    const [row] = await db.select({ until: accountSecretResources.cooldownUntil })
      .from(accountSecretResources).where(eq(accountSecretResources.secretId, id));
    expect(Math.abs(row!.until!.getTime() - (Date.now() + 414_374_000))).toBeLessThan(15_000);

    const rested = await resolveProjectSharedProviderSecrets({
      accountId, projectId: otherProject.project_id, userId: READER, grantUserId: null, providerId: 'codex', name: CODEX,
      ids: [id],
    });
    expect(rested.coolingDown).toBe(true);
    expect(rested.retryAfterSeconds).toBeGreaterThan(414_000);
  });
});
