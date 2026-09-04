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
import { Client, throwIfEdgeLaundered, type Identity } from '../core/client';
import type { Env } from '../core/env';
import { log } from '../core/log';
import type {
  CreatedProject,
  CreatedSession,
  Fixtures,
  Principal,
  Principals,
} from '../core/types';
import type { RegisteredFlow } from '../core/flow';
import { ResourceStack } from './registry';
import { adminDeleteUser } from './supabase';
import { provisionMatrix, synthUser, synthUserWithEmail, type Provisioned } from './principals';
import { provisionProject } from './provision';
import { grantEphemeralPlatformAdmin } from './platform-admin';
import { ADMIN_TOKEN_LABEL, NO_ADMIN_TOKEN_HINT } from './enterprise-demo';
import {
  createDatabaseProject,
  createDatabaseSession,
  deleteDatabaseProject,
  mergeDatabaseProjectMetadata,
} from './database-project';
import { mapWithConcurrency } from '../core/concurrency';
import { createLocalGitRepository } from './local-git';
import type { FixtureStats } from '../core/result';

const PUBLIC_DOMAINS = new Set(['system', 'access']);

export interface World {
  principals: Principals;
  newStack(): ResourceStack;
  /**
   * Fixtures for ONE flow attempt. `attempt` (1-based) namespaces every
   * user-chosen name the attempt derives, so a retry cannot collide with the
   * rows its own previous attempt committed before failing.
   */
  makeFixtures(stack: ResourceStack, attempt?: number): Fixtures;
  fixtureStats(): FixtureStats;
  teardownAll(): Promise<void>;
}

/**
 * The per-attempt suffix for every derived name.
 *
 * Attempt 1 gets NO suffix, so the 100+ existing `fixtures.name()` call sites,
 * the `e2e-%` gc patterns, and every recorded fixture name keep the exact bytes
 * they have today. Only a RETRY is renamed, which is the only case that can
 * collide with itself.
 */
export function attemptSuffix(attempt: number): string {
  return attempt > 1 ? `-r${attempt}` : '';
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
  jwt: string;
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
    jwt: platformAdmin.jwt,
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
    env.adminToken = platformAdmin.jwt;
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
  let databaseProjectCount = 0;
  let managedProjectCount = 0;
  // Session create runs managed-git operations (branch push) synchronously, so
  // it can never succeed against a database-only project's ke2e.invalid remote.
  // Sessions on those projects are written straight to the database instead.
  const databaseProjectIds = new Set<string>();
  // One shared read-only project, provisioned at most once per run.
  let sharedProjectPromise: Promise<CreatedProject> | null = null;
  let sharedSeededProjectPromise: Promise<CreatedProject> | null = null;
  const sharedStack = new ResourceStack(adminClient, deleteDatabaseProjectFixture);

  async function createProject(
    stack: ResourceStack,
    opts?: {
      name?: string;
      accountId?: string;
      seed?: boolean;
      managedGit?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CreatedProject> {
    const name = opts?.name ?? `e2e-${runId}-proj-${rand()}`;
    const accountId = opts?.accountId ?? owner.accountId!;
    if (canCreateDatabaseProject && (env.target === 'local' || (!opts?.seed && !opts?.managedGit))) {
      const localRepository =
        env.target === 'local' && (opts?.seed || opts?.managedGit)
          ? await createLocalGitRepository(name)
          : null;
      if (localRepository) {
        stack.push('local-git', localRepository.root, { dispose: localRepository.dispose });
      }
      const project = await createDatabaseProject(env, {
        accountId,
        userId: owner.userId!,
        name,
        repoUrl: localRepository?.repoUrl,
        metadata: opts?.metadata,
      });
      databaseProjectCount++;
      databaseProjectIds.add(project.id);
      stack.push('database-project', project.id);
      return project;
    }

    const id = await provisionProject(adminClient, {
      name,
      ...(opts?.accountId ? { account_id: opts.accountId } : {}),
      ...(opts?.seed ? { seed_starter: true } : {}),
    });
    managedProjectCount++;
    stack.push('project', id);
    if (opts?.metadata) await mergeDatabaseProjectMetadata(env, id, opts.metadata);
    return { id, name } as CreatedProject;
  }

  const fixturesFor = (stack: ResourceStack, attempt = 1): Fixtures => {
    const suffix = attemptSuffix(attempt);
    return {
    name: (slug) => `e2e-${runId}-${slug}${suffix}`,
    sharedProject() {
      if (!sharedProjectPromise) {
        sharedProjectPromise = createProject(sharedStack, {
          name: `e2e-${runId}-shared`,
          managedGit: true,
        });
      }
      return sharedProjectPromise;
    },
    sharedSeededProject() {
      if (!sharedSeededProjectPromise) {
        sharedSeededProjectPromise = createProject(sharedStack, {
          name: `e2e-${runId}-shared-seeded`,
          seed: true,
        });
      }
      return sharedSeededProjectPromise;
    },
    async project(opts) {
      return createProject(stack, opts);
    },
    async team(opts) {
      const res = await adminClient.post('/v1/accounts', {
        name: opts?.name ?? `e2e-${runId}-team-${rand()}`,
      });
      // IAM-22 (run 32306385663) died here on ONE attempt: the edge laundered
      // an origin blip into a MAINTENANCE_MODE 503, this read found no
      // account_id, and the plain Error below classified as `fatal`.
      throwIfEdgeLaundered(res, 'team account create');
      const accountId = res.json<any>()?.account_id;
      if (!accountId) throw new Error(`team account create returned no id: ${res.text()}`);
      stack.push('account', accountId);
      if (opts?.enterprise) {
        // The enterprise-demo PUT is platform-admin-only — the OWNER of this
        // fixture account gets 403 {code:'admin_required'}. Unlock through the
        // run-scoped platform admin provisioned above.
        if (!env.adminToken) {
          throw new Error(`enterprise team fixture needs a platform admin — ${NO_ADMIN_TOKEN_HINT}`);
        }
        const enabled = await adminClient
          .withBearer(env.adminToken, ADMIN_TOKEN_LABEL)
          .put(
            '/v1/accounts/:accountId/iam/enterprise-demo',
            { enabled: true },
            { params: { accountId } },
          );
        if (enabled.statusCode !== 200 || enabled.json<any>()?.enabled !== true) {
          throw new Error(`enterprise team enable failed: ${enabled.text()}`);
        }
      }
      return {
        id: accountId,
        async addMember(role) {
          const u = await synthUser(env, `MEM-${role}`, runId);
          extraUserIds.push(u.user.id);
          // This response used to be DISCARDED. A failed add then surfaced two
          // steps later as someone else's bug: MEM-4 read `DELETE member → 404`
          // and IAM-36 read `expected exactly one account-scope system
          // assignment, got 0` — both of which mean only "the member was never
          // added". Because addMember runs OUTSIDE ctx.step(), the request was
          // not even in the step log. Fail here, where the cause is.
          const added = await adminClient.post(
            '/v1/accounts/:accountId/members',
            { email: u.user.email, role },
            { params: { accountId } },
          );
          throwIfEdgeLaundered(added, `team addMember(${role})`);
          if (added.statusCode !== 201) {
            throw new Error(
              `team addMember(${role}) failed: ${added.statusCode} ${added.text()}`,
            );
          }
          return u.principal;
        },
        async grantProjectRole(projectId, userId, role) {
          const granted = await adminClient.put(
            '/v1/projects/:projectId/access/:userId',
            { role },
            { params: { projectId, userId } },
          );
          // Same class as addMember above: a swallowed grant becomes a 403 in
          // whichever later step relies on the role.
          throwIfEdgeLaundered(granted, `team grantProjectRole(${role})`);
          if (granted.statusCode !== 200 && granted.statusCode !== 201) {
            throw new Error(
              `team grantProjectRole(${role}) failed: ${granted.statusCode} ${granted.text()}`,
            );
          }
        },
        async project(o) {
          return createProject(stack, {
            ...o,
            name: o?.name ?? `e2e-${runId}-tproj-${rand()}`,
            accountId,
          });
        },
      };
    },
    async user(opts) {
      const u = await synthUser(env, opts?.label ?? 'USER', runId);
      extraUserIds.push(u.user.id);
      // Personal accounts are lazy. Minting a PAT forces the personal account
      // and owner membership into existence without joining this user to any
      // team, which is exactly what account-deletion flows require.
      const bootstrap = await new Client(env.apiUrl)
        .as(u.principal)
        .post('/v1/accounts/tokens', { name: `e2e-${runId}-user-bootstrap${suffix}` });
      throwIfEdgeLaundered(bootstrap, 'standalone user bootstrap');
      if (bootstrap.statusCode !== 201) {
        throw new Error(`standalone user bootstrap failed: ${bootstrap.text()}`);
      }
      return u.principal;
    },
    async userWithEmail(email, opts) {
      const u = await synthUserWithEmail(env, email.toLowerCase(), opts?.label ?? 'ADDRESSEE');
      extraUserIds.push(u.user.id);
      // Same lazy-personal-account bootstrap as `user()` — minting a PAT forces
      // the personal account + owner membership into existence so subsequent
      // account-scoped reads (e.g. /v1/accounts/me) work for this identity.
      const bootstrap = await new Client(env.apiUrl)
        .as(u.principal)
        .post('/v1/accounts/tokens', { name: `e2e-${runId}-user-email-bootstrap${suffix}` });
      throwIfEdgeLaundered(bootstrap, 'standalone user-with-email bootstrap');
      if (bootstrap.statusCode !== 201) {
        throw new Error(`standalone user-with-email bootstrap failed: ${bootstrap.text()}`);
      }
      return u.principal;
    },
    async session(project, opts) {
      if (databaseProjectIds.has(project.id)) {
        const id = await createDatabaseSession(env, {
          projectId: project.id,
          accountId: owner.accountId!,
          userId: owner.userId!,
        });
        // No stack entry: deleting the database-only project cascades to its
        // sessions (project_sessions.project_id ON DELETE CASCADE).
        return { id, projectId: project.id } as CreatedSession;
      }
      // Use only documented session-create fields. Tests that perform inference
      // can pin a model explicitly instead of inheriting the deployment default.
      const res = await adminClient.post(
        '/v1/projects/:projectId/sessions',
        {
          initial_prompt: opts?.prompt ?? 'noop',
          ...(opts?.opencodeModel ? { opencode_model: opts.opencodeModel } : {}),
        },
        {
          params: { projectId: project.id },
        },
      );
      throwIfEdgeLaundered(res, 'session create');
      const body = res.json<any>();
      const id = body?.session_id ?? body?.sessionId ?? body?.id;
      if (!id) throw new Error(`session create returned no id: ${res.text()}`);
      stack.push('session', id, { projectId: project.id });
      return { id, projectId: project.id } as CreatedSession;
    },
    async pat(opts) {
      const res = await adminClient.post('/v1/accounts/tokens', {
        name: opts?.name ?? `e2e-${runId}-pat-${rand()}`,
      });
      throwIfEdgeLaundered(res, 'token mint');
      const body = res.json<any>();
      const secret = body?.secret_key ?? body?.token;
      const tokenId = body?.id ?? body?.token_id;
      if (!secret) throw new Error(`token mint returned no secret: ${res.text()}`);
      if (tokenId) stack.push('token', tokenId);
      return secret as string;
    },
    };
  };

  return {
    principals: principalsProxy(provisioned.principals),
    newStack: () => new ResourceStack(adminClient, deleteDatabaseProjectFixture),
    makeFixtures: fixturesFor,
    fixtureStats: () => ({ databaseProjectCount, managedProjectCount }),
    async teardownAll() {
      log.info(
        `fixtures: ${databaseProjectCount} database-only projects · ${managedProjectCount} managed repositories`,
      );
      await sharedStack.teardown();
      if (revokePlatformAdmin) {
        try {
          await revokePlatformAdmin();
        } catch (err) {
          log.warn(`teardown platform admin role failed: ${(err as Error)?.message ?? err}`);
        }
      }
      for (const acct of provisioned.runAccountIds) {
        try {
          // delete-immediately resolves the caller's account; account_id in body
          // overrides for team accounts the OWNER controls.
          await adminClient.del('/v1/billing/account/delete-immediately', {
            body: { account_id: acct },
          });
        } catch (err) {
          log.warn(`teardown run account ${acct} failed: ${(err as Error)?.message ?? err}`);
        }
      }
      const userIds = [...provisioned.supabaseUserIds, ...extraUserIds];
      // A full run synthesizes hundreds of users. Deleting them 2 at a time
      // added 2-5 min to the tail; 8 matches gc.ts's existing sweep default and
      // is a Supabase admin call, not a provisioning call, so it does not touch
      // the GitHub repo-creation budget. Override with KE2E_TEARDOWN_WORKERS.
      const cleanupWorkers = Number(process.env.KE2E_TEARDOWN_WORKERS ?? 8);
      await mapWithConcurrency(userIds, cleanupWorkers, async (uid) => {
        try {
          await adminDeleteUser(env, uid);
        } catch (err) {
          log.warn(`teardown user ${uid} failed: ${(err as Error)?.message ?? err}`);
        }
      });
    },
  };
}

function makeUnavailableFixtures(): Fixtures {
  const fail = (): never => {
    throw new Error('Fixtures unavailable in a public-only run (no provisioning).');
  };
  return {
    name: (slug) => slug,
    project: fail as any,
    sharedProject: fail as any,
    sharedSeededProject: fail as any,
    session: fail as any,
    pat: fail as any,
    team: fail as any,
    user: fail as any,
    userWithEmail: fail as any,
  };
}

function rand(): string {
  // Deterministic-free randomness via crypto (Math.random is fine here, not in workflow scripts).
  return Math.random().toString(36).slice(2, 8);
}
