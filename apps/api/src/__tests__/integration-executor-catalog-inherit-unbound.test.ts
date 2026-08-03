/**
 * Regression: `kortix executor connectors` / `kortix executor call` returned an
 * EMPTY catalog (and `connector_not_found`) for sessions created with
 * `connector_bindings` set but `inherit_unbound` absent.
 *
 * Root cause: `resolveSessionConnectorProfile` returns `null` for every alias
 * with NO explicit binding when the session has
 * `connector_bindings_configured = true` AND `connector_bindings_inherit_unbound
 * = false` (session-connector-bindings.ts:806). The create path defaulted an
 * ABSENT `inherit_unbound` to `false`, so any caller that sent
 * `connector_bindings: {...}` without `inherit_unbound` hid every unbound
 * connector. `listCatalog` (db-deps.ts) then filtered all those nulls away.
 *
 * Two-layer fix, both exercised here:
 *  1. sessions.ts: an ABSENT `inherit_unbound` now defaults to `true` — only an
 *     EXPLICIT `inherit_unbound: false` opts into fail-closed (the composer's
 *     "I picked these specific connections, turn the others off" signal).
 *  2. db-deps.ts `listCatalog`: a SAFETY NET for sessions created before the
 *     create-path default fix — when the primary resolution returns null, fall
 *     back to the PROJECT DEFAULT profile for aliases with NO durable binding
 *     row. A present-but-revoked binding still fails closed (the security
 *     invariant): the safety net never runs for a connector that HAS a
 *     binding row.
 *
 * Real-Postgres tenant contract — run with DATABASE_URL pointed at an isolated
 * migrated database (mirrors integration-session-connector-profiles.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  executorConnectionProfiles,
  executorConnectors,
  executorCredentials,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { dbExecutorRouterDeps } from '../executor/db-deps';
import {
  resolveProjectDefaultConnectorProfile,
  resolveSessionConnectorProfile,
} from '../projects/lib/session-connector-bindings';
import { encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
// Two connectors: one the session binds (veyris), one it does not (unbound).
const CONNECTOR_BOUND = crypto.randomUUID();
const CONNECTOR_UNBOUND = crypto.randomUUID();
const CONNECTOR_REVOKED = crypto.randomUUID();
const PROFILE_BOUND_DEFAULT = crypto.randomUUID();
const PROFILE_BOUND_MEMBER = crypto.randomUUID();
const PROFILE_UNBOUND_DEFAULT = crypto.randomUUID();
const PROFILE_UNBOUND_MEMBER = crypto.randomUUID();
const PROFILE_REVOKED_DEFAULT = crypto.randomUUID();
const PROFILE_REVOKED_MEMBER = crypto.randomUUID();

// The bug-condition session: bindings configured, inherit_unbound FALSE, binds
// only veyris. Pre-fix this emptied the catalog.
const SESSION_BUG = crypto.randomUUID();
// The fixed create-path default: bindings configured, inherit_unbound TRUE
// (what an ABSENT inherit_unbound now becomes), binds only veyris.
const SESSION_INHERIT = crypto.randomUUID();
// A session with NO bindings configured — legacy, always falls back.
const SESSION_LEGACY = crypto.randomUUID();

function principalFor(sessionId: string | null) {
  return {
    userId: USER,
    accountId: ACCOUNT,
    projectId: PROJECT,
    sessionId,
    subject: { userId: USER, groupIds: [] },
    // Agent grant allows both connectors, so the agent-grant filter is not the
    // thing hiding them — the binding resolution is.
    agentGrant: { agent: 'test', connectors: ['veyris', 'unbound', 'revoked'], kortixCli: [] },
  };
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'catalog-inherit-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'catalog-inherit-test',
    repoUrl: 'https://example.test/catalog-inherit.git',
  });
  await db.insert(executorConnectors).values([
    {
      connectorId: CONNECTOR_BOUND,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'veyris',
      name: 'Veyris',
      providerType: 'http',
      config: { baseUrl: 'https://veyris.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'user',
    },
    {
      connectorId: CONNECTOR_UNBOUND,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'unbound',
      name: 'Unbound',
      providerType: 'http',
      config: { baseUrl: 'https://unbound.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'user',
    },
    {
      connectorId: CONNECTOR_REVOKED,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'revoked',
      name: 'Revoked',
      providerType: 'http',
      config: { baseUrl: 'https://revoked.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'user',
    },
  ]);
  // A project-wide block policy would hide actions, but it does not hide the
  // connector itself — keep it out so the catalog entries are observable.
  await db.insert(executorConnectionProfiles).values([
    {
      profileId: PROFILE_BOUND_DEFAULT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_BOUND,
      label: 'Veyris default',
      isDefault: true,
    },
    {
      profileId: PROFILE_BOUND_MEMBER,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_BOUND,
      ownerType: 'member',
      ownerId: USER,
      label: 'Veyris my workspace',
    },
    {
      profileId: PROFILE_UNBOUND_DEFAULT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_UNBOUND,
      label: 'Unbound default',
      isDefault: true,
    },
    {
      profileId: PROFILE_UNBOUND_MEMBER,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_UNBOUND,
      ownerType: 'member',
      ownerId: USER,
      label: 'Unbound my workspace',
    },
    {
      // The active member default the project-default fallback WOULD pick for
      // `revoked` if the safety net ran — proves the catalog omits `revoked`
      // because of the binding-row guard, not because there is no fallback.
      profileId: PROFILE_REVOKED_DEFAULT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_REVOKED,
      ownerType: 'member',
      ownerId: USER,
      label: 'Revoked active member default',
      isDefault: true,
    },
    {
      profileId: PROFILE_REVOKED_MEMBER,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_REVOKED,
      ownerType: 'member',
      ownerId: USER,
      label: 'Revoked my workspace',
    },
  ]);
  await db.insert(executorCredentials).values([
    {
      connectorId: CONNECTOR_BOUND,
      profileId: PROFILE_BOUND_DEFAULT,
      valueEnc: encryptProjectSecret(PROJECT, 'veyris-default-cap'),
    },
    {
      connectorId: CONNECTOR_BOUND,
      profileId: PROFILE_BOUND_MEMBER,
      valueEnc: encryptProjectSecret(PROJECT, 'veyris-member-cap'),
    },
    {
      connectorId: CONNECTOR_UNBOUND,
      profileId: PROFILE_UNBOUND_DEFAULT,
      valueEnc: encryptProjectSecret(PROJECT, 'unbound-default-cap'),
    },
    {
      connectorId: CONNECTOR_UNBOUND,
      profileId: PROFILE_UNBOUND_MEMBER,
      valueEnc: encryptProjectSecret(PROJECT, 'unbound-member-cap'),
    },
    {
      connectorId: CONNECTOR_REVOKED,
      profileId: PROFILE_REVOKED_DEFAULT,
      valueEnc: encryptProjectSecret(PROJECT, 'revoked-default-cap'),
    },
    {
      connectorId: CONNECTOR_REVOKED,
      profileId: PROFILE_REVOKED_MEMBER,
      valueEnc: encryptProjectSecret(PROJECT, 'revoked-member-cap'),
    },
  ]);
  await db.insert(projectSessions).values([
    {
      // The bug condition: configured + NOT inherit_unbound. Only veyris is bound.
      sessionId: SESSION_BUG,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_BUG,
      createdBy: USER,
      visibility: 'private',
      connectorBindingsConfigured: true,
      connectorBindingsInheritUnbound: false,
    },
    {
      // Fixed: configured + inherit_unbound = true (what absent now defaults to).
      sessionId: SESSION_INHERIT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_INHERIT,
      createdBy: USER,
      visibility: 'private',
      connectorBindingsConfigured: true,
      connectorBindingsInheritUnbound: true,
    },
    {
      // Legacy: no bindings configured at all — always fell back to project default.
      sessionId: SESSION_LEGACY,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_LEGACY,
      createdBy: USER,
      visibility: 'private',
    },
  ]);
  // SESSION_BUG and SESSION_INHERIT both bind veyris (to USER's member profile)
  // AND bind `revoked` to a member profile that we then REVOKE below — proving
  // the safety net never resurrects a present-but-revoked binding.
  await db.insert(projectSessionConnectorBindings).values([
    {
      sessionId: SESSION_BUG,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_BOUND,
      profileId: PROFILE_BOUND_MEMBER,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_BUG,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorAlias: 'revoked',
      connectorId: CONNECTOR_REVOKED,
      profileId: PROFILE_REVOKED_MEMBER,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_INHERIT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_BOUND,
      profileId: PROFILE_BOUND_MEMBER,
      source: 'request',
      createdBy: USER,
    },
  ]);
  // Revoke the `revoked` binding's profile so it resolves null at call time —
  // a present-but-revoked binding must FAIL CLOSED, not fall through to default.
  await db
    .update(executorConnectionProfiles)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(eq(executorConnectionProfiles.profileId, PROFILE_REVOKED_MEMBER));
});

afterAll(async () => {
  await db.delete(projectSessionConnectorBindings).where(eq(projectSessionConnectorBindings.projectId, PROJECT));
  await db.delete(executorCredentials).where(eq(executorCredentials.connectorId, CONNECTOR_BOUND));
  await db
    .delete(executorCredentials)
    .where(eq(executorCredentials.connectorId, CONNECTOR_UNBOUND));
  await db
    .delete(executorCredentials)
    .where(eq(executorCredentials.connectorId, CONNECTOR_REVOKED));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db
    .delete(executorConnectionProfiles)
    .where(eq(executorConnectionProfiles.projectId, PROJECT));
  await db.delete(executorConnectors).where(eq(executorConnectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('executor catalog — inherit_unbound safety net', () => {
  test('the bug condition resolves null for every UNBOUND alias (root-cause reproduction)', async () => {
    // SESSION_BUG is configured + NOT inherit_unbound. Its unbound alias
    // (`unbound`, no binding row) resolves to null — that is the line-806 gate,
    // and it is what emptied the catalog before the safety net.
    const unbound = await resolveSessionConnectorProfile({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_BUG,
      alias: 'unbound',
      actingUserId: USER,
    });
    expect(unbound).toBeNull();
  });

  test('the safety net surfaces the project default for an UNBOUND alias on a pre-fix session', async () => {
    // The catalog for SESSION_BUG must NOT be empty: the `unbound` connector
    // has no binding row, so the safety net falls back to its project-default
    // profile. `veyris` (bound + connected) is listed too. `revoked` (bound but
    // revoked) is NOT listed — the safety net never runs for a connector that
    // HAS a binding row, so the revoked binding fails closed.
    const catalog = await dbExecutorRouterDeps.listCatalog(principalFor(SESSION_BUG));
    const slugs = catalog.map((c) => c.slug).sort();
    expect(slugs).toEqual(['unbound', 'veyris']);
    expect(slugs).not.toContain('revoked');
  });

  test('the explicit-binding still wins over the safety-net project default', async () => {
    // SESSION_BUG binds veyris to PROFILE_BOUND_MEMBER. The catalog must reflect
    // the bound profile, not the project default — the safety net only runs
    // when the PRIMARY resolution returns null, and a connected binding does
    // not. Load the gateway connector to confirm the resolved profile id.
    const deps = dbExecutorRouterDeps.makeGatewayDeps(principalFor(SESSION_BUG));
    const conn = await deps.loadConnectorBySlug(PROJECT, 'veyris');
    expect(conn?.profileId).toBe(PROFILE_BOUND_MEMBER);
  });

  test('a present-but-REVOKED binding fails closed (the safety net does not resurrect it)', async () => {
    // `revoked` has a binding row on SESSION_BUG pointing at a REVOKED profile.
    // The primary resolution returns null (revoked), and because the connector
    // HAS a durable binding, the safety net does NOT run — it stays null. This
    // is the security invariant from session-connector-bindings.ts:669-671.
    const revoked = await resolveSessionConnectorProfile({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_BUG,
      alias: 'revoked',
      actingUserId: USER,
    });
    expect(revoked).toBeNull();

    const projectDefault = await resolveProjectDefaultConnectorProfile({
      accountId: ACCOUNT,
      projectId: PROJECT,
      alias: 'revoked',
      actingUserId: USER,
    });
    // The project default DOES exist for `revoked` (a separate default profile) —
    // proving the catalog omits it because of the binding-row guard, not because
    // there is no fallback available.
    expect(projectDefault?.profileId).toBe(PROFILE_REVOKED_DEFAULT);

    const catalog = await dbExecutorRouterDeps.listCatalog(principalFor(SESSION_BUG));
    expect(catalog.map((c) => c.slug)).not.toContain('revoked');
  });

  test('the fixed create-path default (inherit_unbound=true) lists unbound aliases without the safety net', async () => {
    // SESSION_INHERIT is configured + inherit_unbound=true (what an ABSENT
    // inherit_unbound now defaults to). Its unbound alias resolves directly via
    // the project-default branch — no safety net needed. Every connected
    // connector lists (the bound one via its binding, the unbound ones via the
    // project default).
    const unbound = await resolveSessionConnectorProfile({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_INHERIT,
      alias: 'unbound',
      actingUserId: USER,
    });
    expect(unbound).toMatchObject({ profileId: PROFILE_UNBOUND_MEMBER, source: 'default' });

    const catalog = await dbExecutorRouterDeps.listCatalog(principalFor(SESSION_INHERIT));
    const slugs = catalog.map((c) => c.slug).sort();
    expect(slugs).toEqual(['revoked', 'unbound', 'veyris']);
  });

  test('a legacy session with no bindings configured lists every connected connector', async () => {
    // SESSION_LEGACY has no bindings configured. It always resolved via the
    // project default; this guard confirms the fix did not regress that path.
    const catalog = await dbExecutorRouterDeps.listCatalog(principalFor(SESSION_LEGACY));
    const slugs = catalog.map((c) => c.slug).sort();
    // `revoked`'s member profile is revoked, but its DEFAULT profile is active
    // and connected, so a legacy session sees it via the project default.
    expect(slugs).toEqual(['revoked', 'unbound', 'veyris']);
  });
});
