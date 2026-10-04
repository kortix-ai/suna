/**
 * The "world" = the provisioned principal matrix + fixture factory + global
 * teardown, built once per run. Public-only runs (system/access) need no creds
 * and provision nothing; any auth'd domain triggers full provisioning.
 *
 * NOTE: the full 14-principal matrix (ADMIN, MEMBER, the M_ project roles,
 * BILLING, AUDITOR, RO_ADMIN, DENY_USER, NONMEMBER, PAT_PROJ) is completed in
 * fixtures/principals.ts as the
 * route contracts are pinned by the audit. OWNER/ANON/PAT_ACCT/APIKEY + the run
 * account are wired here.
 */
import { Client, isKe2eRetryableError, type Identity } from '../core/client';
import type { Env } from '../core/env';
import { log } from '../core/log';
import type { Fixtures, Principal, Principals } from '../core/types';
import type { RegisteredFlow } from '../core/flow';
import { waitFor } from '../core/poll';
import { ResourceStack } from './registry';
import { adminDeleteUser } from './supabase';
import { provisionMatrix, synthUser, type Provisioned } from './principals';
import type { SupabaseSessionAuth } from './supabase-session';
import { deleteDatabaseProject } from './database-project';
import { grantEphemeralPlatformAdmin } from './platform-admin';
import {
  makeFixtures,
  teardownWorld,
  type FixtureDeps,
} from './fixture-factory';
import type { FixtureStats } from '../core/result';

export { attemptSuffix, memoizeUntilRejected } from './fixture-factory';

const PUBLIC_DOMAINS = new Set(['system', 'access']);

export interface World {
  principals: Principals;
  newStack(): ResourceStack;
  /**
   * Fixtures for ONE flow attempt. `attempt` (1-based) namespaces every
   * user-chosen name the attempt derives, so a retry cannot collide with the
   * rows its own previous attempt committed before failing. `signal` aborts
   * when the attempt ends; fixtures still waiting (a queued or rate-limited
   * project provision) stop instead of outliving the flow.
   */
  makeFixtures(stack: ResourceStack, attempt?: number, signal?: AbortSignal): Fixtures;
  fixtureStats(): FixtureStats;
  teardownAll(): Promise<void>;
}

const ANON_PRINCIPAL: Principal = { label: 'ANON', auth: { mode: 'none' } };

function principalsProxy(provided: Partial<Principals>): Principals {
  return new Proxy(provided, {
    get(target, prop: string) {
      if (prop in target) return (target as any)[prop];
      if (prop === 'ANON') return ANON_PRINCIPAL;
      throw new Error(
        `Principal "${String(prop)}" is not provisioned in this run. ` +
          `Provide owner creds + service-role key, or this principal isn't wired yet (see fixtures/principals.ts).`,
      );
    },
  }) as Principals;
}

interface EphemeralPlatformAdmin {
  userId: string;
  /** Self-renewing credential; `env.adminToken` reads its current token. */
  session: SupabaseSessionAuth;
  /** Remove the granted role at teardown. */
  revoke: () => Promise<void>;
  /** Undo everything this fixture created, for an aborted buildWorld. */
  release: () => Promise<void>;
}

/** Synthesize a user and grant it the run-scoped platform super-admin role. */
async function provisionPlatformAdmin(
  env: Env,
  runId: string,
): Promise<EphemeralPlatformAdmin> {
  const platformAdmin = await synthUser(env, 'PLATFORM-ADMIN', runId);
  let revoke: () => Promise<void>;
  try {
    revoke = await grantEphemeralPlatformAdmin(env, platformAdmin.user.id);
  } catch (err) {
    await adminDeleteUser(env, platformAdmin.user.id);
    throw err;
  }
  return {
    userId: platformAdmin.user.id,
    session: platformAdmin.session,
    revoke,
    release: async () => {
      await revoke().catch(() => undefined);
      await adminDeleteUser(env, platformAdmin.user.id).catch(() => undefined);
    },
  };
}

export async function buildWorld(env: Env, flows: RegisteredFlow[]): Promise<World> {
  const needsAuth = flows.some((f) => !PUBLIC_DOMAINS.has(f.meta.domain));

  if (!needsAuth) {
    log.info(log.dim('world: public-only run — no principals provisioned'));
    const principals = principalsProxy({ ANON: ANON_PRINCIPAL, accountId: '' });
    const noFixtures: Fixtures = makeUnavailableFixtures();
    return {
      principals,
      newStack: () => new ResourceStack(new Client(env.apiUrl)),
      makeFixtures: () => noFixtures,
      fixtureStats: () => ({ databaseProjectCount: 0, managedProjectCount: 0 }),
      teardownAll: async () => {},
    };
  }

  if (!env.capabilities.supabaseAdmin || !env.supabaseAnonKey) {
    throw new Error(
      "Auth'd flows selected but no Supabase admin access. Set KE2E_SUPABASE_SERVICE_ROLE_KEY " +
        '+ KE2E_SUPABASE_ANON_KEY (the suite synthesizes principals), or restrict to --domain system,access.',
    );
  }

  const runId = (globalThis as any).__KE2E_RUN_ID__ ?? 'run';

  // Release QA needs a real, short-lived Supabase identity for the platform
  // admin success paths. A server API key is not a human identity and cannot
  // satisfy requireAdmin. Keep OWNER non-admin so every negative boundary
  // assertion remains honest; synthesize a dedicated principal instead.
  //
  // It depends on nothing in provisionMatrix, so both run at once. Nothing in
  // the suite starts until this whole block finishes, so every second saved
  // here is a second off the wall clock. allSettled keeps a rejection on one
  // side from stranding the resources the other side already created.
  const wantsPlatformAdmin = env.capabilities.database && env.target !== 'prod';
  const [matrixSettled, adminSettled] = await Promise.allSettled([
    provisionMatrix(env, runId),
    wantsPlatformAdmin ? provisionPlatformAdmin(env, runId) : Promise.resolve(null),
  ]);

  if (matrixSettled.status === 'rejected') {
    if (adminSettled.status === 'fulfilled' && adminSettled.value) {
      await adminSettled.value.release().catch(() => undefined);
    }
    throw matrixSettled.reason;
  }
  const provisioned: Provisioned = matrixSettled.value;
  if (adminSettled.status === 'rejected') throw adminSettled.reason;

  let revokePlatformAdmin: (() => Promise<void>) | null = null;
  if (adminSettled.value) {
    const platformAdmin = adminSettled.value;
    provisioned.supabaseUserIds.push(platformAdmin.userId);
    revokePlatformAdmin = platformAdmin.revoke;
    // A getter, not a snapshot: flows call withBearer(env.adminToken) at use
    // time and must get the renewed token after the first hour.
    Object.defineProperty(env, 'adminToken', {
      configurable: true,
      enumerable: true,
      get: () => platformAdmin.session.token,
    });
    env.capabilities.admin = true;
    log.step(`provision: run-scoped platform admin ${platformAdmin.userId} active`);
  }

  const owner = provisioned.principals.OWNER!;
  const adminClient = new Client(env.apiUrl).as(owner as Identity);
  const canCreateDatabaseProject = env.capabilities.database && env.target !== 'prod';
  const deleteDatabaseProjectFixture = canCreateDatabaseProject
    ? (projectId: string) => deleteDatabaseProject(env, projectId)
    : undefined;
  // Users synthesized mid-run (team members) — deleted in teardownAll.
  const extraUserIds: string[] = [];
  // Session create runs managed-git operations (branch push) synchronously, so
  // it can never succeed against a database-only project's ke2e.invalid remote.
  // Sessions on those projects are written straight to the database instead.
  const databaseProjectIds = new Set<string>();
  // Owns the run-scoped shared projects (see fixture-factory.ts).
  const sharedStack = new ResourceStack(adminClient, deleteDatabaseProjectFixture);

  const deps: FixtureDeps = {
    env,
    runId,
    adminClient,
    owner,
    canCreateDatabaseProject,
    sharedStack,
    databaseProjectCount: 0,
    managedProjectCount: 0,
    extraUserIds,
    databaseProjectIds,
    supabaseUserIds: provisioned.supabaseUserIds,
    revokePlatformAdmin,
  };

  return {
    principals: principalsProxy(provisioned.principals),
    newStack: () => new ResourceStack(adminClient, deleteDatabaseProjectFixture),
    makeFixtures: makeFixtures(deps),
    fixtureStats: () => ({
      databaseProjectCount: deps.databaseProjectCount,
      managedProjectCount: deps.managedProjectCount,
    }),
    teardownAll: () => teardownWorld(deps),
  };
}

// Cold provider images can take longer than a flow's runtime deadline. Build
// one through the real session route before measuring concurrent user flows.
// The capability+flows guard lives at the call site in core/runner.ts.
export async function warmDefaultSandboxImage(env: Env, world: World): Promise<void> {
  const stack = world.newStack();
  try {
    const fixtures = world.makeFixtures(stack);
    const project = await fixtures.sharedSeededProject();
    const client = new Client(env.apiUrl).as(world.principals.OWNER);
    const created = await client.post('/v1/projects/:projectId/sessions', {},
      { params: { projectId: project.id } });
    created.status(201);
    const sessionId = created.json<{ session_id: string }>().session_id;
    if (!sessionId) throw new Error('sandbox setup returned no session_id');
    stack.push('session', sessionId, { projectId: project.id });
    // TWO SEQUENTIAL PHASES, TWO INDEPENDENT BUDGETS.
    //
    // These waits used to share one `setupDeadline = Date.now() + 900_000`
    // while the FIRST was itself allowed `timeoutMs: 900_000`. So a cold
    // image build that legitimately took most of its 15 minutes left the
    // second wait `Math.max(1, setupDeadline - Date.now())` === 1 ms, and
    // it "timed out" instantly on a runtime that was never given a chance
    // to boot.
    //
    // That is exactly how every API shard of the release gate died on
    // v0.13.21, v0.13.22, v0.13.23 and v0.13.24: the log shows phase one
    // starting, no image-readiness error, the "…image and runtime ready"
    // line never printed, and `Timed out waiting for sandbox fixture
    // readiness` at 942 s — 900 s of image build plus overhead, then 1 ms
    // for the boot. The gate reported the product broken four releases
    // running while nothing about the product was wrong.
    //
    // Budget arithmetic against the shard's own 60-minute cap
    // (`tests-release.yml`): 15 min image + 10 min runtime = 25 min worst
    // case, leaving 35 min for the flows, which run in 19-25 min. Both
    // phases are fast whenever the image is already baked, which is the
    // normal case; these ceilings only cover a cold deploy.
    const IMAGE_READY_TIMEOUT_MS = 900_000;
    const RUNTIME_READY_TIMEOUT_MS = 600_000;
    log.info('sandbox setup: waiting for the current default image (up to 15 minutes), then its runtime (up to 10 minutes)');
    // Session boot can use the previous ready image while the current one
    // builds. The preview gate must exercise this deploy's baked daemon.
    await waitFor(async () => {
      const snapshots = await client.get('/v1/projects/:projectId/snapshots',
        { params: { projectId: project.id } });
      snapshots.status(200);
      const template = snapshots.json<{ templates: Array<{
        is_default: boolean;
        ready: boolean;
        provider_coverage?: Array<{ launch_ready: boolean }>;
      }> }>().templates.find((template) => template.is_default);
      return template?.ready === true ||
        template?.provider_coverage?.some((provider) => provider.launch_ready === true) === true;
    }, { until: (ready) => ready, timeoutMs: IMAGE_READY_TIMEOUT_MS, intervalMs: 5000,
      // A transport error while staging bakes this deploy's image is not a
      // verdict on the image: keep polling inside the same deadline.
      retryOnError: isKe2eRetryableError,
      description: 'current default sandbox image readiness' });
    await waitFor(async () => {
      const ready = await client.post('/v1/projects/:projectId/sessions/:sessionId/start', {},
        { params: { projectId: project.id, sessionId }, query: { wait_ms: '8000' }, timeoutMs: 30_000 });
      ready.status(200);
      const body = ready.json<{ stage: string; retriable: boolean; message?: string }>();
      if (body.stage === 'error' && !body.retriable) throw new Error(JSON.stringify(body));
      return body.stage;
    }, { until: (stage) => stage === 'ready', timeoutMs: RUNTIME_READY_TIMEOUT_MS, intervalMs: 3000,
      // POST /start is idempotent. One timed-out call during the first boot
      // on a fresh image killed whole release shards; poll again instead.
      retryOnError: isKe2eRetryableError,
      description: 'sandbox fixture readiness' });
    log.info('sandbox setup: current default image and runtime ready');
  } finally {
    await stack.teardown();
  }
}

function makeUnavailableFixtures(): Fixtures {
  const fail = (): never => {
    throw new Error('Fixtures unavailable in a public-only run (no provisioning).');
  };
  return {
    name: (slug) => slug,
    project: fail,
    sharedProject: fail,
    sharedSeededProject: fail,
    session: fail,
    pat: fail,
    team: fail,
    user: fail,
    userWithEmail: fail,
  };
}
