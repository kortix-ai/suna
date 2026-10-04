/**
 * The fixture surface of the world (see world.ts): the per-attempt fixtures,
 * the run-scoped shared projects, and the teardown. buildWorld keeps
 * provisioning + wiring and hands this factory one shared state object
 * (`FixtureDeps`) in place of the closure variables it used to capture.
 *
 * world.ts re-exports `attemptSuffix`/`memoizeUntilRejected` here so their
 * import sites stay stable; this file never imports world.ts.
 */
import { Client, throwIfEdgeLaundered } from '../core/client';
import type { Env } from '../core/env';
import { log } from '../core/log';
import type {
  CreatedProject,
  CreatedSession,
  Fixtures,
  Harness,
  Principal,
} from '../core/types';
import { mapWithConcurrency } from '../core/concurrency';
import type { ResourceStack } from './registry';
import { adminDeleteUser } from './supabase';
import { synthUser, synthUserWithEmail, type SynthUser } from './principals';
import { stopAllSessionRefresh } from './supabase-session';
import { provisionProject } from './provision';
import { ADMIN_TOKEN_LABEL, NO_ADMIN_TOKEN_HINT, enableEnterpriseDemoAs } from './enterprise-demo';
import {
  createDatabaseProject,
  createDatabaseSession,
  mergeDatabaseProjectMetadata,
} from './database-project';
import { createLocalGitRepository } from './local-git';

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

/**
 * Share one in-flight or settled creation between callers, but forget a
 * rejection so the next caller creates it again.
 *
 * `sharedProject()` used to cache its first promise forever. On preview run
 * 36067774228 that first provision failed on a GitHub rate limit at 23:04Z,
 * and every later flow that asked for the shared project failed in 0.0 s with
 * the same error, through CONN-5 at 23:37Z, without one new attempt.
 */
export function memoizeUntilRejected<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      const created = factory();
      cached = created;
      created.catch(() => {
        if (cached === created) cached = null;
      });
    }
    return cached;
  };
}

/**
 * The state buildWorld shares with the fixture factory and the teardown — one
 * object in place of the closure variables buildWorld used to capture. The
 * counters are mutated in place so `fixtureStats()` and `teardownWorld` still
 * see every fixture the run created.
 */
export interface FixtureDeps {
  env: Env;
  runId: string;
  adminClient: Client;
  owner: Principal;
  canCreateDatabaseProject: boolean;
  sharedStack: ResourceStack;
  databaseProjectCount: number;
  managedProjectCount: number;
  extraUserIds: string[];
  databaseProjectIds: Set<string>;
  supabaseUserIds: string[];
  revokePlatformAdmin: (() => Promise<void>) | null;
}

/**
 * Bind the run-scoped fixture surface to `deps`. Called once per world; the
 * returned function is the per-attempt `World.makeFixtures`.
 */
export function makeFixtures(
  deps: FixtureDeps,
): (stack: ResourceStack, attempt?: number, signal?: AbortSignal) => Fixtures {
  const {
    adminClient,
    canCreateDatabaseProject,
    databaseProjectIds,
    env,
    extraUserIds,
    owner,
    runId,
    sharedStack,
  } = deps;

  async function createProject(
    stack: ResourceStack,
    opts?: {
      name?: string;
      accountId?: string;
      seed?: boolean;
      managedGit?: boolean;
      allowAllSecrets?: boolean;
      allowAllConnectors?: boolean;
      metadata?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<CreatedProject> {
    const name = opts?.name ?? `e2e-${runId}-proj-${rand()}`;
    const accountId = opts?.accountId ?? owner.accountId!;
    if (canCreateDatabaseProject && (env.target === 'local' || (!opts?.seed && !opts?.managedGit))) {
      const localRepository =
        env.target === 'local' && (opts?.seed || opts?.managedGit)
          ? await createLocalGitRepository(name, {
              allowAllSecrets: opts?.allowAllSecrets,
              allowAllConnectors: opts?.allowAllConnectors,
            })
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
      deps.databaseProjectCount++;
      databaseProjectIds.add(project.id);
      stack.push('database-project', project.id);
      return { ...project, accountId };
    }

    const id = await provisionProject(
      adminClient,
      {
        name,
        ...(opts?.accountId ? { account_id: opts.accountId } : {}),
        ...(opts?.seed ? { seed_starter: true } : {}),
      },
      { signal },
    );
    deps.managedProjectCount++;
    stack.push('project', id);
    if (opts?.metadata) await mergeDatabaseProjectMetadata(env, id, opts.metadata);
    return { id, name, accountId } as CreatedProject;
  }

  // Run-scoped: no attempt signal. One flow's timeout must not abort the
  // shared project every other flow is waiting on.
  const sharedProject = memoizeUntilRejected(() =>
    createProject(sharedStack, { name: `e2e-${runId}-shared`, managedGit: true }),
  );
  const sharedSeededOpenCode = memoizeUntilRejected(() =>
    createProject(sharedStack, { name: `e2e-${runId}-shared-seeded`, seed: true }),
  );
  // The pi twin: the same starter, with the project's `pi_harness` flag on, so
  // every session in it boots pi (apps/api selectSessionHarness).
  const sharedSeededPi = memoizeUntilRejected(async () => {
    const project = await createProject(sharedStack, { name: `e2e-${runId}-shared-seeded-pi`, seed: true });
    const res = await adminClient.patch(
      '/v1/projects/:projectId/features',
      { feature: 'pi_harness', enabled: true },
      { params: { projectId: project.id } },
    );
    throwIfEdgeLaundered(res, 'pi_harness flag');
    if (res.statusCode !== 200 || res.json<any>()?.experimental?.pi_harness !== true) {
      throw new Error(`pi_harness flag did not turn on for ${project.id}: ${res.statusCode} ${res.text()}`);
    }
    return project;
  });
  const sharedSeededProject = (harness: Harness = 'opencode') =>
    harness === 'pi' ? sharedSeededPi() : sharedSeededOpenCode();

  return (stack: ResourceStack, attempt = 1, signal?: AbortSignal): Fixtures => {
    const suffix = attemptSuffix(attempt);
    return {
      name: (slug) => `e2e-${runId}-${slug}${suffix}`,
      sharedProject,
      sharedSeededProject,
      async project(opts) {
        return createProject(stack, opts, signal);
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
          await enableEnterpriseDemoAs(
            adminClient.withBearer(env.adminToken, ADMIN_TOKEN_LABEL),
            accountId,
          );
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
            return createProject(
              stack,
              {
                ...o,
                name: o?.name ?? `e2e-${runId}-tproj-${rand()}`,
                accountId,
              },
              signal,
            );
          },
        };
      },
      async user(opts) {
        return bootstrapSynthUser(
          deps,
          suffix,
          () => synthUser(env, opts?.label ?? 'USER', runId),
          'user-bootstrap',
          'standalone user bootstrap',
        );
      },
      async userWithEmail(email, opts) {
        return bootstrapSynthUser(
          deps,
          suffix,
          () => synthUserWithEmail(env, email.toLowerCase(), opts?.label ?? 'ADDRESSEE'),
          'user-email-bootstrap',
          'standalone user-with-email bootstrap',
        );
      },
      async session(project, opts) {
        if (databaseProjectIds.has(project.id)) {
          const id = await createDatabaseSession(env, {
            projectId: project.id,
            accountId: project.accountId ?? owner.accountId!,
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
            ...(opts?.agentName ? { agent_name: opts.agentName } : {}),
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
}

/**
 * Synthesize a user and force its lazy personal account into existence.
 *
 * Personal accounts are lazy. Minting a PAT forces the personal account
 * and owner membership into existence without joining this user to any
 * team, which is exactly what account-deletion flows require.
 */
async function bootstrapSynthUser(
  deps: FixtureDeps,
  suffix: string,
  synth: () => Promise<SynthUser>,
  bootstrapName: string,
  errorLabel: string,
): Promise<Principal> {
  const u = await synth();
  deps.extraUserIds.push(u.user.id);
  const bootstrap = await new Client(deps.env.apiUrl)
    .as(u.principal)
    .post('/v1/accounts/tokens', { name: `e2e-${deps.runId}-${bootstrapName}${suffix}` });
  throwIfEdgeLaundered(bootstrap, errorLabel);
  if (bootstrap.statusCode !== 201) {
    throw new Error(`${errorLabel} failed: ${bootstrap.text()}`);
  }
  return u.principal;
}

/** The world's `teardownAll` (see world.ts): undo every fixture this run created. */
export async function teardownWorld(deps: FixtureDeps): Promise<void> {
  stopAllSessionRefresh();
  log.info(
    `fixtures: ${deps.databaseProjectCount} database-only projects · ${deps.managedProjectCount} managed repositories`,
  );
  await deps.sharedStack.teardown();
  if (deps.revokePlatformAdmin) {
    try {
      await deps.revokePlatformAdmin();
    } catch (err) {
      log.warn(`teardown platform admin role failed: ${(err as Error)?.message ?? err}`);
    }
  }
  const userIds = [...deps.supabaseUserIds, ...deps.extraUserIds];
  // A full run synthesizes hundreds of users. Deleting them 2 at a time
  // added 2-5 min to the tail; 8 matches gc.ts's existing sweep default and
  // is a Supabase admin call, not a provisioning call, so it does not touch
  // the GitHub repo-creation budget. Override with KE2E_TEARDOWN_WORKERS.
  const cleanupWorkers = Number(process.env.KE2E_TEARDOWN_WORKERS ?? 8);
  await mapWithConcurrency(userIds, cleanupWorkers, async (uid) => {
    try {
      await adminDeleteUser(deps.env, uid);
    } catch (err) {
      log.warn(`teardown user ${uid} failed: ${(err as Error)?.message ?? err}`);
    }
  });
}

function rand(): string {
  // Deterministic-free randomness via crypto (Math.random is fine here, not in workflow scripts).
  return Math.random().toString(36).slice(2, 8);
}
