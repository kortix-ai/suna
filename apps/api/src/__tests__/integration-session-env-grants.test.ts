/**
 * Integration test (real local DB): session-env injection under the secrets v2
 * identifier model. Authorization is centralized on the agent's `secrets`
 * grant, applied BY IDENTIFIER via `listProjectSecretsSnapshotForUser` (the
 * resolver `buildSessionSandboxEnvVars` calls at sandbox boot) — there is no
 * resource-side allow-list and no per-secret member/group sharing left to test.
 *
 * Covers the model's headline scenario: two identifiers sharing one env-var
 * KEY (GMAPS-primary / GMAPS-backup, both GOOGLE_MAPS_API_KEY) — an agent
 * granted one specific identifier gets exactly that value injected.
 *
 * Runs against the local Postgres (DATABASE_URL).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { and, eq, sql, inArray, isNull } from 'drizzle-orm';
import {
  accountMembers,
  accounts,
  auditEvents,
  auditSessionSequences,
  connectors,
  projects,
  projectSecrets,
  projectSessionSecretHandles,
  projectSessions,
} from '@kortix/db';
import { db } from '../shared/db';
import { resolveSandboxEnvSnapshot } from '../projects/lib/sandbox-env-sync';
import { buildSessionSandboxEnvVars } from '../projects/lib/sessions';
import {
  AmbiguousSecretGrantError,
  confineSharedProjectSecretToConnector,
  encryptProjectSecret,
  intersectSecretGrants,
  listProjectSecretsSnapshotForUser,
  writeSharedProjectSecret,
} from '../projects/secrets';
import { insertIntoView } from './helpers/compat-views';
import { seedAccount } from './helpers/integration-fixtures';

let ctx: { projectId: string; accountId: string };
const USER = crypto.randomUUID();
const SESSION_ID = `e2e-clobber-${crypto.randomUUID()}`;
const SUFFIX = crypto.randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '');
const KEY = `E2E_GMAPS_${SUFFIX}`;
const PRIMARY = `${KEY}-primary`;
const BACKUP = `${KEY}-backup`;
const UNSCOPED = `E2E_UNSCOPED_${SUFFIX}`;
// Per-user override scenario: one identifier with a shared row plus two personal
// (ownerUserId) overrides — the mechanism behind CODEX_AUTH_JSON.
const OWNER = crypto.randomUUID();
const RESTARTER = crypto.randomUUID();
const OVERRIDE_IDENT = `E2E_OVR_${SUFFIX}`;
const OVERRIDE_KEY = `E2E_OVR_KEY_${SUFFIX}`;
const PRINCIPAL_SESSION = `e2e-principal-${crypto.randomUUID()}`;
const WRAPPER_API_IDENT = `wrapper-api-url-${SUFFIX}`;
const WRAPPER_TOKEN_IDENT = `wrapper-agent-token-${SUFFIX}`;
const WRAPPER_SESSION = `e2e-wrapper-${crypto.randomUUID()}`;
const BROKER_IDENT = `E2E_BROKER_${SUFFIX}`;
const BROKER_KEY = `E2E_BROKER_KEY_${SUFFIX}`;
const BROKER_SESSION = `e2e-broker-${crypto.randomUUID()}`;
const BROKER_VALUE = `broker-plaintext-${crypto.randomUUID()}`;
const CONNECTOR_IDENT = `E2E_CONNECTOR_${SUFFIX}`;
const CONNECTOR_KEY = `E2E_CONNECTOR_KEY_${SUFFIX}`;

beforeAll(async () => {
  ctx = { projectId: crypto.randomUUID(), accountId: await seedAccount('session-env-grants') };
  // The session owner is a member of the account. Session secrets resolve as
  // the owner only after that membership check passes.
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: ctx.accountId, accountRole: 'member' },
  ]);
  await db.insert(projects).values({
    projectId: ctx.projectId,
    accountId: ctx.accountId,
    name: `Secret delivery test ${SUFFIX}`,
    repoUrl: resolve(import.meta.dir, '../../../..'),
    // This suite tests session allowlist and secret-delivery composition. An
    // ungoverned project resolves the same unrestricted agent grant without a
    // Git checkout, which keeps the real-DB assertions deterministic.
    defaultBranch: '',
    manifestPath: '',
  });

  // Two identifiers, SAME key — the headline secrets-v2 scenario.
  await writeSharedProjectSecret({
    projectId: ctx.projectId,
    identifier: PRIMARY,
    name: KEY,
    value: 'primary-val',
  });
  await writeSharedProjectSecret({
    projectId: ctx.projectId,
    identifier: BACKUP,
    name: KEY,
    value: 'backup-val',
  });
  await writeSharedProjectSecret({
    projectId: ctx.projectId,
    name: UNSCOPED,
    value: 'open-val',
  });
  await writeSharedProjectSecret({
    projectId: ctx.projectId,
    identifier: CONNECTOR_IDENT,
    name: CONNECTOR_KEY,
    value: 'connector-only-val',
  });
  await db.insert(connectors).values({
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    slug: `connector-${SUFFIX.toLowerCase()}`,
    name: 'Connector boundary fixture',
    providerType: 'http',
    config: { baseUrl: 'https://connector.example.test', auth: { type: 'bearer' } },
    authSecret: CONNECTOR_IDENT,
  });

  // One identifier with a shared value plus a distinct personal override for
  // OWNER and for RESTARTER — so the resolved value differs by principal.
  await writeSharedProjectSecret({
    projectId: ctx.projectId,
    identifier: OVERRIDE_IDENT,
    name: OVERRIDE_KEY,
    value: 'shared-val',
  });
  const now = new Date();
  await db.insert(projectSecrets).values([
    {
      projectId: ctx.projectId,
      identifier: OVERRIDE_IDENT,
      name: OVERRIDE_KEY,
      ownerUserId: OWNER,
      active: true,
      valueEnc: encryptProjectSecret(ctx.projectId, 'owner-val'),
      scope: 'runtime',
      updatedAt: now,
    },
    {
      projectId: ctx.projectId,
      identifier: OVERRIDE_IDENT,
      name: OVERRIDE_KEY,
      ownerUserId: RESTARTER,
      active: true,
      valueEnc: encryptProjectSecret(ctx.projectId, 'restarter-val'),
      scope: 'runtime',
      updatedAt: now,
    },
  ]);
  // A session OWNED by OWNER — used to prove sandbox-boot resolves secrets as the
  // owner even when some other principal provisions the run.
  await db.insert(projectSessions).values({
    sessionId: PRINCIPAL_SESSION,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: `kaab-principal-${SUFFIX}`,
    createdBy: OWNER,
    agentName: 'default',
  });
  await db.insert(projectSessions).values({
    sessionId: WRAPPER_SESSION,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: `kaab-wrapper-${SUFFIX}`,
    createdBy: USER,
    agentName: 'wrapper-agent',
    // A backend wrapper narrows its session to the two identifiers it sends on
    // create.
    secretsAllowlist: [WRAPPER_API_IDENT, WRAPPER_TOKEN_IDENT],
  });
  await writeSharedProjectSecret({
    projectId: ctx.projectId,
    identifier: BROKER_IDENT,
    name: BROKER_KEY,
    value: BROKER_VALUE,
  });
  await db
    .update(projectSecrets)
    .set({
      strategy: 'broker',
      consumer: 'http_broker',
      egressPolicy: {
        backend: 'kortix_fetch',
        rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
        inject: {
          kind: 'header',
          name: 'authorization',
          template: 'Bearer {{secret}}',
        },
        on_no_match: 'deny',
        tls: 'terminate',
      },
      handlePrefix: 'test_broker_',
    })
    .where(
      and(
        eq(projectSecrets.projectId, ctx.projectId),
        eq(projectSecrets.identifier, BROKER_IDENT),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  await db.insert(projectSessions).values({
    sessionId: BROKER_SESSION,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: `broker-${SUFFIX}`,
    createdBy: USER,
    agentName: 'broker-test',
    secretsAllowlist: [BROKER_IDENT],
  });
});

afterAll(async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local kortix.audit_maintenance = 'on'`);
    await tx.delete(auditEvents).where(eq(auditEvents.projectId, ctx!.projectId));
    await tx
      .delete(auditSessionSequences)
      .where(
        inArray(auditSessionSequences.sessionId, [
          SESSION_ID,
          PRINCIPAL_SESSION,
          WRAPPER_SESSION,
          BROKER_SESSION,
        ]),
      );
  });
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION_ID));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, PRINCIPAL_SESSION));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, WRAPPER_SESSION));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, BROKER_SESSION));
  await db
    .delete(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, ctx.projectId),
        inArray(projectSecrets.identifier, [
          PRIMARY,
          BACKUP,
          UNSCOPED,
          OVERRIDE_IDENT,
          WRAPPER_API_IDENT,
          WRAPPER_TOKEN_IDENT,
          BROKER_IDENT,
          CONNECTOR_IDENT,
        ]),
      ),
    );
  await db.delete(projects).where(eq(projects.projectId, ctx.projectId));
  await db.delete(accounts).where(eq(accounts.accountId, ctx.accountId));
});

describe('listProjectSecretsSnapshotForUser — session env injection by identifier', () => {
  test('a connector binding excludes a legacy runtime row and permanently confines it', async () => {
    const before = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, [CONNECTOR_IDENT]);
    expect(before.env).toEqual({});
    expect(before.names).toEqual([]);

    await confineSharedProjectSecretToConnector(ctx.projectId, CONNECTOR_IDENT);
    const [row] = await db
      .select({
        scope: projectSecrets.scope,
        strategy: projectSecrets.strategy,
        consumer: projectSecrets.consumer,
        strategyLocked: projectSecrets.strategyLocked,
      })
      .from(projectSecrets)
      .where(
        and(
          eq(projectSecrets.projectId, ctx.projectId),
          eq(projectSecrets.identifier, CONNECTOR_IDENT),
          isNull(projectSecrets.ownerUserId),
        ),
      );
    expect(row).toEqual({
      scope: 'connector',
      strategy: 'broker',
      consumer: 'connector',
      strategyLocked: true,
    });
  });

  test('an agent granted ONE identifier gets exactly that value under the shared key', async () => {
    const { env, names } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, [PRIMARY]);
    expect(env[KEY]).toBe('primary-val');
    expect(names).toContain(KEY);
    // Only the granted identifier's key is present — nothing else leaks in.
    expect(Object.keys(env)).toEqual([KEY]);
  });

  test('a DIFFERENT identifier grant gets the OTHER value under the same key', async () => {
    const { env } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, [BACKUP]);
    expect(env[KEY]).toBe('backup-val');
  });

  test("'all' (default/back-compat) sees every identifier, deterministically resolving the shared key", async () => {
    const { env, names } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, 'all');
    expect(env[UNSCOPED]).toBe('open-val');
    expect(names).toContain(UNSCOPED);
    // One of the two GMAPS values wins deterministically — never both/neither.
    expect(isEitherGmapsValue(env)).toBe(true);
  });

  test('an agent granted BOTH identifiers for the same key is ambiguous — rejected', async () => {
    await expect(
      listProjectSecretsSnapshotForUser(ctx.projectId, USER, [PRIMARY, BACKUP]),
    ).rejects.toThrow(AmbiguousSecretGrantError);
  });

  test('an unscoped (single-identifier) secret is unaffected by the collision above', async () => {
    const { env } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, [UNSCOPED]);
    expect(env).toEqual({ [UNSCOPED]: 'open-val' });
  });

  test('a KaaB per-session allowlist narrows an "all" agent grant (the boot/hot-push composition)', async () => {
    // Both sandbox boot (buildSessionSandboxEnvVars) and hot-push
    // (resolveOwnerRawEnv) compose intersectSecretGrants(grant, allowlist) and
    // pass the result to this resolver. An "all" agent grant narrowed by a
    // session allowlist of [UNSCOPED] must inject ONLY that secret — proving the
    // narrowing against the real DB, end-to-end with the functions in the path.
    const narrowed = intersectSecretGrants('all', [UNSCOPED]);
    const { env } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, narrowed);
    expect(env).toEqual({ [UNSCOPED]: 'open-val' });

    // A null allowlist is a passthrough — every secret the grant already allowed
    // (byte-identical to pre-KaaB).
    const passthrough = intersectSecretGrants('all', null);
    const { names } = await listProjectSecretsSnapshotForUser(ctx.projectId, USER, passthrough);
    expect(names).toContain(UNSCOPED);
    expect(names).toContain(KEY);
  });

  test('resolveSandboxEnvSnapshot (hot-push) reads + applies the session secretsAllowlist — the CLOBBER FIX', async () => {
    await db.insert(projectSessions).values({
      sessionId: SESSION_ID,
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      branchName: `kaab-clobber-${SUFFIX}`,
      createdBy: USER,
      agentName: 'default',
      secretsAllowlist: [UNSCOPED],
    });
    const narrowed = await resolveSandboxEnvSnapshot(ctx.projectId, SESSION_ID);
    expect(narrowed?.env[UNSCOPED]).toBe('open-val');
    expect(narrowed?.env[KEY]).toBeUndefined();

    await db
      .update(projectSessions)
      .set({ secretsAllowlist: null })
      .where(eq(projectSessions.sessionId, SESSION_ID));
    const passthroughSnap = await resolveSandboxEnvSnapshot(ctx.projectId, SESSION_ID);
    expect(passthroughSnap?.env[UNSCOPED]).toBe('open-val');
    expect(passthroughSnap?.env[KEY]).toBeDefined();
  });

  test('sandbox-boot resolves per-user overrides as the session OWNER, not the provisioner', async () => {
    // Control: the two principals genuinely resolve DIFFERENT values for the same
    // identifier — so an incorrect principal would be observable.
    const asOwner = await listProjectSecretsSnapshotForUser(ctx.projectId, OWNER, [OVERRIDE_IDENT]);
    const asRestarter = await listProjectSecretsSnapshotForUser(ctx.projectId, RESTARTER, [
      OVERRIDE_IDENT,
    ]);
    expect(asOwner.env[OVERRIDE_KEY]).toBe('owner-val');
    expect(asRestarter.env[OVERRIDE_KEY]).toBe('restarter-val');

    // The full sandbox-boot builder, invoked with userId = RESTARTER (a manager
    // restarting OWNER's session). It must resolve secrets as the session's
    // createdBy (OWNER), not the provisioning principal — otherwise the
    // restarter's personal secret would boot into the owner's session and then
    // flip-flop on the first prompt's hot-push (which is keyed on createdBy).
    // `defaultBranch` omitted → agent grant defaults to 'all' (no git/manifest).
    const env = await buildSessionSandboxEnvVars({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      sessionId: PRINCIPAL_SESSION,
      userId: RESTARTER,
      repoUrl: 'https://example.test/principal.git',
      baseRef: 'main',
      agentName: 'default',
      llmGatewayEnabled: false,
    });
    expect(env[OVERRIDE_KEY]).toBe('owner-val');
  });

  test('sandbox boot snapshots the latest committed backend-wrapper capability secrets without caching', async () => {
    await writeSharedProjectSecret({
      projectId: ctx.projectId,
      identifier: WRAPPER_API_IDENT,
      name: 'WRAPPER_API_URL',
      value: 'https://stale.wrapper.example.test',
    });
    await writeSharedProjectSecret({
      projectId: ctx.projectId,
      identifier: WRAPPER_TOKEN_IDENT,
      name: 'WRAPPER_AGENT_TOKEN',
      value: 'stale-capability',
    });

    // Mirrors the correct wrapper ordering: both upsert responses have landed
    // before session create is allowed to snapshot the environment.
    await Promise.all([
      writeSharedProjectSecret({
        projectId: ctx.projectId,
        identifier: WRAPPER_API_IDENT,
        name: 'WRAPPER_API_URL',
        value: 'https://fresh.wrapper.example.test',
      }),
      writeSharedProjectSecret({
        projectId: ctx.projectId,
        identifier: WRAPPER_TOKEN_IDENT,
        name: 'WRAPPER_AGENT_TOKEN',
        value: 'fresh-capability',
      }),
    ]);

    // defaultBranch omitted deliberately: the session allowlist is still
    // applied and proves these identifiers survive Suna's boot-time grant fold.
    const env = await buildSessionSandboxEnvVars({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      sessionId: WRAPPER_SESSION,
      userId: USER,
      repoUrl: 'https://example.test/wrapper.git',
      baseRef: 'main',
      agentName: 'wrapper-agent',
      llmGatewayEnabled: false,
    });
    expect(env.WRAPPER_API_URL).toBe('https://fresh.wrapper.example.test');
    expect(env.WRAPPER_AGENT_TOKEN).toBe('fresh-capability');
    expect(env.KORTIX_PROJECT_SECRET_NAMES?.split(',').sort()).toEqual([
      'WRAPPER_AGENT_TOKEN',
      'WRAPPER_API_URL',
    ]);
  });

  test('broker delivery stores one auditable session handle and never returns plaintext', async () => {
    const first = await listProjectSecretsSnapshotForUser(
      ctx.projectId,
      USER,
      [BROKER_IDENT],
      BROKER_SESSION,
    );
    expect(first.env[BROKER_KEY]).toStartWith('test_broker_KXS1');
    expect(first.env[BROKER_KEY]).not.toContain(BROKER_VALUE);
    expect(first.names).toEqual([BROKER_KEY]);
    expect(first.capabilities.capabilities).toEqual([
      {
        identifier: BROKER_IDENT,
        delivery: 'https_broker',
        command: `kortix secrets call ${BROKER_IDENT} <https-url> [options]`,
      },
    ]);
    expect(first.capabilitiesJson).not.toContain(BROKER_VALUE);
    expect(first.capabilitiesJson).not.toContain(first.env[BROKER_KEY]!);

    const second = await listProjectSecretsSnapshotForUser(
      ctx.projectId,
      USER,
      [BROKER_IDENT],
      BROKER_SESSION,
    );
    expect(second.env[BROKER_KEY]).toBe(first.env[BROKER_KEY]);

    const handles = await db
      .select()
      .from(projectSessionSecretHandles)
      .where(eq(projectSessionSecretHandles.sessionId, BROKER_SESSION));
    expect(handles).toHaveLength(1);
    expect(handles[0]?.status).toBe('active');
    expect(handles[0]?.identifier).toBe(BROKER_IDENT);
    expect(handles[0]?.handleHash).toBe(
      createHash('sha256').update(first.env[BROKER_KEY]!).digest('hex'),
    );
    expect(JSON.stringify(handles[0])).not.toContain(BROKER_VALUE);
    expect(JSON.stringify(handles[0])).not.toContain(first.env[BROKER_KEY]!);

    const issuedEvents = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.projectId, ctx.projectId),
          eq(auditEvents.sessionId, BROKER_SESSION),
          eq(auditEvents.action, 'secret.handle.issued'),
        ),
      );
    expect(issuedEvents).toHaveLength(1);
    expect(issuedEvents[0]?.metadata).toMatchObject({
      identifier: BROKER_IDENT,
      consumer: 'http_broker',
      strategy: 'broker',
      revision: 1,
    });
    expect(JSON.stringify(issuedEvents[0])).not.toContain(BROKER_VALUE);
    expect(JSON.stringify(issuedEvents[0])).not.toContain(first.env[BROKER_KEY]!);

    await db
      .update(projectSecrets)
      .set({
        egressPolicy: {
          backend: 'kortix_fetch',
          rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v2/*' }],
          inject: {
            kind: 'header',
            name: 'authorization',
            template: 'Bearer {{secret}}',
          },
          on_no_match: 'deny',
          tls: 'terminate',
        },
      })
      .where(
        and(
          eq(projectSecrets.projectId, ctx.projectId),
          eq(projectSecrets.identifier, BROKER_IDENT),
          isNull(projectSecrets.ownerUserId),
        ),
      );
    const rotated = await listProjectSecretsSnapshotForUser(
      ctx.projectId,
      USER,
      [BROKER_IDENT],
      BROKER_SESSION,
    );
    expect(rotated.env[BROKER_KEY]).not.toBe(first.env[BROKER_KEY]);
    const revisions = await db
      .select()
      .from(projectSessionSecretHandles)
      .where(eq(projectSessionSecretHandles.sessionId, BROKER_SESSION))
      .orderBy(projectSessionSecretHandles.revision);
    expect(revisions.map((row) => [row.revision, row.status])).toEqual([
      [1, 'superseded'],
      [2, 'active'],
    ]);
    expect(revisions[1]?.policySnapshot.rules[0]?.path).toBe('/v2/*');
    expect(JSON.stringify(revisions)).not.toContain(BROKER_VALUE);
  });

  test('broker delivery stays absent for an unscoped grant', async () => {
    const snapshot = await listProjectSecretsSnapshotForUser(
      ctx.projectId,
      USER,
      'all',
      BROKER_SESSION,
    );
    expect(snapshot.env[BROKER_KEY]).toBeUndefined();
    expect(snapshot.names).not.toContain(BROKER_KEY);
    const capabilities = snapshot.capabilities.capabilities;
    expect(capabilities.some((capability) => capability.identifier === UNSCOPED)).toBe(true);
    expect(capabilities.some((capability) => capability.identifier === BROKER_IDENT)).toBe(false);
  });
});

function isEitherGmapsValue(env: Record<string, string>): boolean {
  return env[KEY] === 'primary-val' || env[KEY] === 'backup-val';
}
