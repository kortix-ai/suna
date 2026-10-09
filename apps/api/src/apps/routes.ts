import { revokeAppViewerTokens } from './viewer';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import {
  appArtifacts,
  appDeploymentEvents,
  appDeployments,
  appRuntimes,
  appSiteFiles,
  apps,
} from '@kortix/db';
import { and, desc, eq, inArray, isNull, max, ne, notInArray, sql } from 'drizzle-orm';
import { auth, errors, json } from '../openapi';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { db } from '../shared/db';
import { inspectDatabaseError } from '../shared/database-errors';
import {
  AppArtifactStorageUnavailableError,
  createAppArtifactUploadUrl,
  MAX_ARCHIVE_BYTES,
} from './artifacts';
import { APP_RUNTIME_VERSION, triggerAppDeploymentWorker } from './deployment-worker';
import { AppHostingProvider } from './hosting';
import { deploymentEventsAsLogs } from './logs';
import { releaseDeploymentImage, releaseDeploymentImages, teardownAppRuntimes } from './images';
import { rollBackActiveDeployment } from './retention';
import { ensureAppRuntimeRunning, loadPublicApp } from './public-proxy';
import { type AppSourceSpec } from './spec';
import { appPublicUrl } from './hostnames';
import { AppBudgetExceededError, alwaysOnBudgetWarning, defaultAppBudgetUsd } from './budget';
import {
  APP_MACHINE_LIMITS,
  AppAccountUnfundedError,
  AppLimitError,
  assertAppBudgetWithinLimits,
  assertAppMachineWithinLimits,
  assertAppAccountFunded,
  assertAppQuotaAvailable,
} from './limits';
import { callerKortixSessionId } from '../middleware/caller-session';
import { projectsApp } from '../projects/lib/app';
import { resolveSessionSandboxRegion } from '../platform/services/sandbox-region';
import { isPlatinumConfigured } from '../shared/platinum';
import { logger } from '../lib/logger';
import { readAgentsGrantingApp } from './agent-grants';
import {
  appAccessibleToUser,
  appsOpenableByUser,
  appAccessSessionUrl,
  filterAppsVisibleToUser,
  persistAppAccessPolicy,
  serializeAppAccessPolicy,
  validateAppAccessPrincipals,
} from './access';
import { APP_KINDS, type AppHostingType } from './kinds';
import { authorizedProject, capabilityRefusal, visibleApp } from './route-access';
import { AppObject, appJson, appsJson } from './serialize';
import { UnknownLinkedAppError, setAppLinks } from './links';
import { registerAppCapabilityRoutes } from './capability-routes';
import {
  BACKEND_MACHINE_LIMITS,
  BackendLimitError,
  getLiveConvexApp,
  insertConvexApp,
  newConvexSize,
  provisionBackend,
} from './kinds/convex/provision';
import { CONVEX_CLI_VERSION } from './kinds/convex/convex-image';
import { BackendOperationError, backendOperation, beginResize, backendProviderFailure, retireConvexApp, runResize } from './kinds/convex/operations';

/** The machine bounds an App shares with a session sandbox. Stated here so the
 *  published OpenAPI schema carries the real ceiling instead of a number the
 *  runtime would refuse. */
const CpuSchema = z.number().int().min(APP_MACHINE_LIMITS.cpu.min).max(APP_MACHINE_LIMITS.cpu.max);
const MemorySchema = z.number().int().min(APP_MACHINE_LIMITS.memory.min).max(APP_MACHINE_LIMITS.memory.max);
const DiskSchema = z.number().int().min(APP_MACHINE_LIMITS.disk.min).max(APP_MACHINE_LIMITS.disk.max);

/** Translate an App resource refusal into its documented HTTP answer. */
function appLimitResponse(c: any, error: unknown): Response | null {
  if (error instanceof AppLimitError) {
    return c.json({ error: error.message, code: error.code, ...error.detail }, error.status);
  }
  if (error instanceof AppAccountUnfundedError) {
    return c.json({ error: error.message, code: error.reason, ...error.detail }, 402);
  }
  if (error instanceof AppBudgetExceededError) {
    return c.json({
      error: error.message,
      code: 'app_budget_exceeded',
      spent_usd: error.spentUsd,
      budget_usd: error.budgetUsd,
    }, 402);
  }
  return null;
}

const DeploymentObject = z.object({}).passthrough().openapi('KortixAppDeployment');
const ArtifactObject = z.object({}).passthrough().openapi('KortixAppArtifact');
/** Deployment states the worker still drives. Deleting one would race its build. */
const IN_PROGRESS_DEPLOYMENT_STATUSES = ['queued', 'validating', 'building', 'provisioning', 'checking'];
/** Provider images a delete freed now, and the ones maintenance retries. */
const ImageReleaseObject = z.object({ released: z.number().int(), pending: z.number().int() })
  .openapi('KortixAppImageRelease');
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APP_ENV_NAME = /^(?!KORTIX_|OPENCODE_)[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const APP_SECRET_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/**
 * The Apps (by slug, in this App's project) this App uses: it may mint their
 * sign-in tokens. Each must exist. Empty, the default: none.
 */
const UsesSchema = z
  .array(z.string().regex(APP_SLUG, 'an App slug: lowercase letters, numbers and single hyphens'))
  .max(20)
  .transform((slugs) => [...new Set(slugs)]);
const EnvironmentSchema = z.record(
  z.string().regex(APP_ENV_NAME),
  z.string().max(32_768),
).refine((value) => Object.keys(value).length <= 128, 'environment supports at most 128 entries');
const SecretMappingsSchema = z.record(
  z.string().regex(APP_ENV_NAME),
  z.string().regex(APP_SECRET_IDENTIFIER),
).refine((value) => Object.keys(value).length <= 128, 'secrets supports at most 128 entries');

const SourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('static'),
    root: z.string().optional(),
    spa: z.boolean().optional(),
    readiness_path: z.string().optional(),
  }),
  z.object({
    kind: z.literal('bundle'),
    install_command: z.string().optional(),
    build_command: z.string().optional(),
    output_dir: z.string().optional(),
    spa: z.boolean().optional(),
    readiness_path: z.string().optional(),
  }),
  z.object({
    kind: z.literal('dockerfile'),
    dockerfile: z.string().optional(),
    command: z.array(z.string()).min(1),
    port: z.number().int(),
    readiness_path: z.string().optional(),
    restart_limit: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('oci_image'),
    image: z.string(),
    command: z.array(z.string()).min(1),
    port: z.number().int(),
    readiness_path: z.string().optional(),
    restart_limit: z.number().int().optional(),
  }),
]);

/** What a `convex` App records after the client CLI deployed its functions. */
const ConvexSourceSchema = z.object({
  kind: z.literal('convex'),
  revision: z.string().max(200).optional().openapi({ description: 'What was deployed, e.g. a git commit. Shown in the history.' }),
});

function sourceFromWire(input: z.infer<typeof SourceSchema>): AppSourceSpec {
  switch (input.kind) {
    case 'static':
      return { kind: input.kind, root: input.root, spa: input.spa, readinessPath: input.readiness_path };
    case 'bundle':
      return {
        kind: input.kind,
        installCommand: input.install_command,
        buildCommand: input.build_command,
        outputDir: input.output_dir,
        spa: input.spa,
        readinessPath: input.readiness_path,
      };
    case 'dockerfile':
      return {
        kind: input.kind,
        dockerfile: input.dockerfile,
        command: input.command,
        port: input.port,
        readinessPath: input.readiness_path,
        restartLimit: input.restart_limit,
      };
    case 'oci_image':
      return {
        kind: input.kind,
        image: input.image,
        command: input.command,
        port: input.port,
        readinessPath: input.readiness_path,
        restartLimit: input.restart_limit,
      };
  }
}

function serializeArtifact(row: typeof appArtifacts.$inferSelect) {
  return {
    artifact_id: row.artifactId,
    project_id: row.projectId,
    kind: row.kind,
    status: row.status,
    image_reference: row.imageReference,
    sha256: row.sha256,
    size_bytes: row.sizeBytes,
    media_type: row.mediaType,
    error: row.error,
    created_at: row.createdAt.toISOString(),
  };
}

function serializeDeployment(row: typeof appDeployments.$inferSelect) {
  return {
    deployment_id: row.deploymentId,
    app_id: row.appId,
    artifact_id: row.artifactId,
    version: row.version,
    status: row.status,
    source_kind: row.sourceKind,
    hosting_type: row.hostingType,
    hosting_provider: row.hostingProvider,
    runtime_spec: row.runtimeSpec,
    build_spec: row.buildSpec,
    error_code: row.errorCode,
    error: row.error,
    attempt_count: row.attemptCount,
    started_at: row.startedAt?.toISOString() ?? null,
    ready_at: row.readyAt?.toISOString() ?? null,
    failed_at: row.failedAt?.toISOString() ?? null,
    created_by: row.createdBy,
    source_session_id: row.sourceSessionId,
    actor_type: row.actorType,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function appDeploymentActorType(c: any): 'human' | 'agent' | 'service_account' | 'system' {
  if (callerKortixSessionId(c)) return 'agent';
  if (c.get('authType') === 'service_account') return 'service_account';
  if (c.get('authType') === 'apiKey') return 'system';
  return 'human';
}

const AppAccessSchema = z.object({
  mode: z.enum(['private', 'project', 'restricted', 'public', 'password']),
  revision: z.number().int().positive(),
  member_ids: z.array(z.string().uuid()).max(100).default([]),
  group_ids: z.array(z.string().uuid()).max(100).default([]),
  password_configured: z.boolean(),
  viewer_token_scope: z.enum(['off', 'identity', 'api']),
});

export { agentsGrantingApp } from './agent-grants';

/**
 * Records a deployment of a `convex` App: the client CLI already deployed the
 * functions with the admin credentials, so the row is `ready` at once. It is
 * history, not routing: `active_deployment_id` does not move.
 */
async function recordConvexDeployment(c: Context<AppEnv>, appId: string, userId: string, revision: string | null) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId}))`);
    const [versionRow] = await tx.select({ value: max(appDeployments.version) }).from(appDeployments)
      .where(eq(appDeployments.appId, appId));
    const now = new Date();
    const [row] = await tx.insert(appDeployments).values({
      appId,
      artifactId: null,
      version: Number(versionRow?.value ?? 0) + 1,
      status: 'ready',
      sourceKind: 'convex',
      hostingType: 'convex',
      createdBy: userId,
      sourceSessionId: callerKortixSessionId(c),
      actorType: appDeploymentActorType(c),
      runtimeVersion: CONVEX_CLI_VERSION,
      buildSpec: { source: { kind: 'convex', revision } },
      runtimeSpec: {},
      startedAt: now,
      readyAt: now,
    }).returning();
    return row!;
  });
}

/** A `convex` refusal (cap, size) or provider failure as its documented answer; null for anything else. */
function convexRefusal(c: Context<AppEnv>, error: unknown): Response | null {
  if (error instanceof BackendLimitError || error instanceof BackendOperationError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  const known = backendProviderFailure(error);
  if (!known) return null;
  logger.warn('[apps] provider call failed', { path: c.req.path, code: known.code, error: String(error) });
  return c.json({ error: known.message, code: known.code }, known.status);
}

/** Sets the Apps this App uses; the 400 to answer when a slug names no live App of the project. */
async function linkOrRefuse(c: Context<AppEnv>, app: typeof apps.$inferSelect, uses: string[] | undefined): Promise<Response | null> {
  if (uses === undefined) return null;
  try {
    await setAppLinks(app, uses);
    return null;
  } catch (error) {
    if (!(error instanceof UnknownLinkedAppError)) throw error;
    return c.json({ error: error.message, code: 'app_not_found', slugs: error.slugs }, 400);
  }
}

/**
 * Create, kind `convex`: claim the slug (App + machine row, capped per project
 * and account), link it, then provision the machine in the background. A
 * failure lands on the row as `instance.status: "error"`; the provision
 * heartbeats, so maintenance resumes it if this process dies.
 */
async function createConvexApp(
  c: Context<AppEnv>,
  loaded: { userId: string; row: { accountId: string; metadata: unknown } },
  body: { slug: string; name: string; cpu?: number; memory_gb?: number; disk_gb?: number; always_on?: boolean; monthly_budget_usd?: number; uses: string[] },
): Promise<Response> {
  const projectId = c.req.param('projectId')!;
  const accountId = loaded.row.accountId;
  if (!isPlatinumConfigured()) {
    return c.json({ error: 'This deployment cannot run convex Apps: it has no Platinum machine provider.', code: 'app_kind_unavailable' }, 409);
  }
  if (body.always_on === false) {
    return c.json({ error: 'A convex App always runs; always_on cannot be false.', code: 'app_always_on_required' }, 400);
  }
  let size: ReturnType<typeof newConvexSize>;
  try {
    size = newConvexSize({ cpu: body.cpu, memoryGb: body.memory_gb, diskGb: body.disk_gb });
    assertAppBudgetWithinLimits(body.monthly_budget_usd);
    await assertAppQuotaAvailable(accountId);
    // The machine bills its reserved size from its first second.
    await assertAppAccountFunded(accountId);
  } catch (error) {
    const refusal = appLimitResponse(c, error) ?? convexRefusal(c, error);
    if (refusal) return refusal;
    throw error;
  }
  const budget = body.monthly_budget_usd
    ?? defaultAppBudgetUsd({ cpuCores: size.cpu, memoryGb: size.memoryGb, diskGb: size.diskGb, alwaysOn: true }, 'platinum');
  let created: Awaited<ReturnType<typeof insertConvexApp>>;
  try {
    created = await insertConvexApp({
      projectId,
      accountId,
      userId: loaded.userId,
      slug: body.slug,
      name: body.name.trim(),
      size,
      monthlyBudgetUsd: budget.toFixed(2),
      monthlyBudgetExplicit: body.monthly_budget_usd !== undefined,
    });
  } catch (error) {
    if (inspectDatabaseError(error)?.pgCode === '23505') return c.json({ error: 'An App with this slug already exists' }, 409);
    const refusal = convexRefusal(c, error);
    if (refusal) return refusal;
    throw error;
  }
  const linked = body.uses.length ? await linkOrRefuse(c, created.app, body.uses) : null;
  if (linked) {
    // Nothing runs yet: the App and its machine row go (cascade).
    await db.delete(apps).where(eq(apps.appId, created.app.appId));
    return linked;
  }
  void provisionBackend(created.row, resolveSessionSandboxRegion(loaded.row.metadata as Record<string, unknown>)).catch((error) =>
    logger.error('[apps] convex provision failed', { projectId, appId: created.app.appId, error: String(error) }),
  );
  return c.json({ ...(await appJson(created.app)), warnings: [] }, 201);
}

/**
 * Starts the resize of a `convex` App: the wallet gate when it grows, the
 * operation claim (409 `app_busy`), then the resize in the background (its
 * result lands on the machine row; it heartbeats, so maintenance recovers the
 * App if this process dies). Null when started, else the Response to answer.
 */
async function startConvexResize(
  c: Context<AppEnv>,
  projectId: string,
  app: typeof apps.$inferSelect,
  next: { cpuCores: number; memoryGb: number; diskGb: number },
): Promise<Response | null> {
  const row = await getLiveConvexApp(projectId, app.appId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  const grows = next.cpuCores > row.cpu || next.memoryGb > row.memoryGb || next.diskGb > row.diskGb;
  try {
    if (grows) await assertAppAccountFunded(row.accountId);
    const size = await beginResize(row, { cpu: next.cpuCores, memoryGb: next.memoryGb, diskGb: next.diskGb });
    void runResize(row, size);
  } catch (error) {
    const refusal = appLimitResponse(c, error) ?? convexRefusal(c, error);
    if (refusal) return refusal;
    throw error;
  }
  return null;
}

/** Delete, kind `convex`: project.app.admin, the typed slug, then a retained delete (kinds/convex/operations.ts retireConvexApp). */
async function deleteConvexApp(c: Context<AppEnv>, projectId: string, app: typeof apps.$inferSelect): Promise<Response> {
  const admin = await authorizedProject(c, projectId, 'admin');
  if (admin instanceof Response) return admin;
  const body = await c.req.json().catch(() => ({}));
  const confirm = c.req.query('confirm') ?? (typeof body?.confirm === 'string' ? body.confirm : undefined);
  if (confirm !== app.slug) {
    return c.json({
      error: `This App holds data. Type its slug to delete it: confirm=${app.slug}.`,
      code: 'confirmation_required',
    }, 400);
  }
  const row = await getLiveConvexApp(projectId, app.appId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  let retired: Awaited<ReturnType<typeof retireConvexApp>>;
  try {
    retired = await retireConvexApp(row);
  } catch (error) {
    logger.error('[apps] convex delete failed', { projectId, appId: app.appId, error: String(error) });
    return c.json({ error: 'The App machine could not be stopped. Try again.', code: 'app_delete_failed' }, 502);
  }
  if (!retired) {
    const busy = backendOperation(row) ?? 'running another operation';
    return c.json({ error: `the App is ${busy}; delete it when that finishes`, code: 'app_busy' }, 409);
  }
  return c.json({
    ok: true,
    images: { released: 0, pending: 0 },
    retained_until: retired.purgeAfter,
    final_snapshot_id: retired.finalSnapshotId,
  });
}

export function registerAppsRoutes(): void {
  registerAppCapabilityRoutes();
  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps', tags: ['apps'], summary: 'List Apps', ...auth,
      request: { params: z.object({ projectId: z.string().uuid() }) },
      responses: { 200: json(z.object({ apps: z.array(AppObject) }), 'Apps'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const rows = await db.select().from(apps)
        .where(and(eq(apps.projectId, projectId), isNull(apps.deletedAt)))
        .orderBy(desc(apps.createdAt));
      const visible = await filterAppsVisibleToUser(rows, loaded.userId);
      const openable = await appsOpenableByUser(visible, loaded.userId);
      return c.json({ apps: await appsJson(visible, openable) });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/access', tags: ['apps'], summary: 'Get App access policy', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
      responses: { 200: json(AppAccessSchema, 'App access policy'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await visibleApp(projectId, appId, loaded.userId);
      return row ? c.json(await serializeAppAccessPolicy(row)) : c.json({ error: 'Not found' }, 404);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch', path: '/{projectId}/apps/{appId}/access', tags: ['apps'], summary: 'Update App access policy', ...auth,
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({
          mode: z.enum(['private', 'project', 'restricted', 'public', 'password']),
          member_ids: z.array(z.string().uuid()).max(100).optional(),
          group_ids: z.array(z.string().uuid()).max(100).optional(),
          password: z.string().min(8).max(256).optional(),
          viewer_token_scope: z.enum(['off', 'identity', 'api']).optional(),
        }) } } },
      },
      responses: { 200: json(AppAccessSchema, 'App access policy'), ...errors(400, 403, 404) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId, 'write');
      if (loaded instanceof Response) return loaded;
      const current = await visibleApp(projectId, appId, loaded.userId);
      if (!current) return c.json({ error: 'Not found' }, 404);
      const body = c.req.valid('json');
      if (body.mode === 'password' && !body.password && !current.accessPasswordHash) {
        return c.json({ error: 'password is required when password access is enabled' }, 400);
      }
      const memberIds: string[] = [...new Set<string>((body.member_ids ?? []) as string[])];
      const groupIds: string[] = [...new Set<string>((body.group_ids ?? []) as string[])];
      if (body.mode === 'restricted' && memberIds.length + groupIds.length === 0) {
        return c.json({ error: 'restricted access requires at least one member or group' }, 400);
      }
      if (body.mode === 'restricted') {
        const validation = await validateAppAccessPrincipals(loaded.row.accountId, {
          memberIds,
          groupIds,
        });
        if (!validation.ok) {
          return c.json({
            error: `${validation.principalType} not found in this account`,
            principal_id: validation.principalId,
          }, 404);
        }
      }
      const row = await persistAppAccessPolicy(current, {
        mode: body.mode,
        memberIds,
        groupIds,
        password: body.password,
        viewerTokenScope: body.viewer_token_scope,
      });
      // Every viewer token this App minted dies with the old policy. Narrowing
      // access has to take effect NOW, not in up to an hour: the cookie is
      // revision-checked on the next request, and this closes the same door on
      // the token an App is already holding.
      await revokeAppViewerTokens(current.appId).catch((error) => {
        console.warn(`[apps] viewer-token revoke failed for ${current.appId}:`, error);
      });
      return c.json(await serializeAppAccessPolicy(row));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/agents', tags: ['apps'], summary: 'List the agents granted this App in kortix.yaml', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
      responses: {
        200: json(z.object({ agents: z.array(z.object({
          agent_name: z.string(),
          grant: z.enum(['all', 'listed']),
          path: z.string(),
        })) }), 'Agents whose apps grant names this App'),
        ...errors(403, 404, 503),
      },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await visibleApp(projectId, appId, loaded.userId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const project = loaded.row;
      if (!project.defaultBranch) return c.json({ agents: [] });
      try {
        const agents = await readAgentsGrantingApp({
          projectId: project.projectId,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath ?? 'kortix.yaml',
          gitAuthToken: null,
        }, row.slug);
        return c.json({ agents });
      } catch (error) {
        return c.json({ error: `kortix.yaml could not be read: ${(error as Error).message}` }, 503);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/access-session', tags: ['apps'], summary: 'Create an App browser access session', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
      responses: { 200: json(z.object({ url: z.string().url(), expires_at: z.string() }), 'App access session'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await visibleApp(projectId, appId, loaded.userId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const refusal = capabilityRefusal(c, row, 'preview');
      if (refusal) return refusal;
      if (row.accessMode !== 'public' && row.accessMode !== 'password' && !(await appAccessibleToUser(row, loaded.userId))) {
        return c.json({ error: 'App access denied' }, 403);
      }
      // A PASSWORD App gets the bare URL: the door is the password prompt, and a
      // Kortix session cannot stand in for knowing the secret.
      if (row.accessMode === 'password') {
        return c.json({ url: appPublicUrl(row), expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
      }
      // A PUBLIC App gets a real session URL, the same as a gated one.
      //
      // It used to get the bare URL, which meant a public App could never
      // recognise anyone: no access link, so no identity cookie, so no viewer
      // header — `public` silently also meant `anonymous`. Opening it from Kortix
      // now carries who you are, while the bare URL underneath stays shareable
      // with someone who has no Kortix account at all. The gate does not GATE a
      // public App either way; this only decides whether it can greet you.
      const session = appAccessSessionUrl(appPublicUrl(row), row, loaded.userId);
      return c.json({ url: session.url, expires_at: session.expiresAt.toISOString() });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps', tags: ['apps'], summary: 'Create an App', ...auth,
      description:
        '`kind` (default `web`) is fixed for the App\'s life. A `web` App serves what its deployments build. A ' +
        '`convex` App is a self-hosted Convex backend in its own always-on machine (default 1 CPU, 1 GB, 10 GB; ' +
        `CPU ${BACKEND_MACHINE_LIMITS.cpu.min}-${BACKEND_MACHINE_LIMITS.cpu.max}, memory ${BACKEND_MACHINE_LIMITS.memoryGb.min}-${BACKEND_MACHINE_LIMITS.memoryGb.max} GB, ` +
        `disk ${BACKEND_MACHINE_LIMITS.diskGb.min}-${BACKEND_MACHINE_LIMITS.diskGb.max} GB): it answers 201 with ` +
        '`instance.status: "provisioning"`; poll the App until it is `running` or `error` (seconds; the first in a ' +
        'region builds the image). At most 3 `convex` Apps per project and 10 per account (409 `app_kind_limit`). ' +
        'A `convex` App needs a funded account (402) and a deployment with Platinum (409 `app_kind_unavailable`).',
      request: {
        params: z.object({ projectId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({
          slug: z.string().min(1).max(63), name: z.string().min(1).max(200),
          kind: z.enum(APP_KINDS).default('web'),
          cpu: CpuSchema.optional(),
          memory_gb: MemorySchema.optional(),
          disk_gb: DiskSchema.optional(),
          idle_timeout_seconds: z.number().int().min(120).max(86400).default(300),
          always_on: z.boolean().optional(),
          monthly_budget_usd: z.number().min(0).max(100000).optional(),
          uses: UsesSchema.default([]),
        }) } } },
      },
      responses: { 201: json(AppObject, 'App'), ...errors(400, 402, 403, 404, 409) },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await authorizedProject(c, projectId, 'write');
      if (loaded instanceof Response) return loaded;
      const body = c.req.valid('json');
      const slug = body.slug.toLowerCase();
      if (!APP_SLUG.test(slug)) return c.json({ error: 'slug must contain lowercase letters, numbers, and single hyphens' }, 400);
      if (body.kind === 'convex') return createConvexApp(c, loaded, { ...body, slug });
      const machine = { cpu: body.cpu ?? 1, memoryGb: body.memory_gb ?? 2, diskGb: body.disk_gb ?? 10 };
      try {
        assertAppMachineWithinLimits(machine);
        assertAppBudgetWithinLimits(body.monthly_budget_usd);
        await assertAppQuotaAvailable(loaded.row.accountId);
      } catch (error) {
        const refusal = appLimitResponse(c, error);
        if (refusal) return refusal;
        throw error;
      }
      let row: typeof apps.$inferSelect;
      try {
        const alwaysOn = body.always_on ?? config.KORTIX_APPS_DEFAULT_ALWAYS_ON;
        const budget = body.monthly_budget_usd
          ?? defaultAppBudgetUsd({ cpuCores: machine.cpu, memoryGb: machine.memoryGb, diskGb: machine.diskGb, alwaysOn }, config.getDefaultProvider());
        [row] = (await db.insert(apps).values({
          accountId: loaded.row.accountId, projectId, slug, name: body.name.trim(),
          routeKey: randomBytes(8).toString('hex'), createdBy: loaded.userId,
          cpuCores: machine.cpu, memoryGb: machine.memoryGb, diskGb: machine.diskGb,
          idleTimeoutSeconds: body.idle_timeout_seconds,
          alwaysOn,
          monthlyBudgetUsd: budget.toFixed(2),
          monthlyBudgetExplicit: body.monthly_budget_usd !== undefined,
        }).returning()) as [typeof apps.$inferSelect];
      } catch (error) {
        // Drizzle wraps the postgres.js error, so the SQLSTATE lives on
        // error.cause.code, NOT error.code — reading error.code left this branch
        // dead and a duplicate-slug create returned 500 instead of 409.
        // inspectDatabaseError walks the .cause chain for the real pgCode.
        if (inspectDatabaseError(error)?.pgCode === '23505')
          return c.json({ error: 'An App with this slug already exists' }, 409);
        throw error;
      }
      const linked = body.uses.length ? await linkOrRefuse(c, row, body.uses) : null;
      if (linked) {
        await db.delete(apps).where(eq(apps.appId, row.appId));
        return linked;
      }
      const warning = alwaysOnBudgetWarning(row, config.getDefaultProvider());
      return c.json({ ...(await appJson(row)), warnings: warning ? [warning] : [] }, 201);
    },
  );

  // Static artifact routes are registered before /apps/{appId}.
  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/artifacts', tags: ['apps'], summary: 'Register an App artifact', ...auth,
      request: {
        params: z.object({ projectId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('archive'), media_type: z.string().optional() }),
          z.object({ kind: z.literal('oci_image'), image: z.string().min(1).max(512) }),
        ]) } } },
      },
      responses: { 201: json(z.object({ artifact: ArtifactObject, upload: z.object({ url: z.string(), max_bytes: z.number() }).nullable() }), 'Artifact'), ...errors(400, 403, 404, 503) },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await authorizedProject(c, projectId, 'deploy');
      if (loaded instanceof Response) return loaded;
      const body = c.req.valid('json');
      const artifactId = randomUUID();
      if (body.kind === 'oci_image') {
        const [artifact] = await db.insert(appArtifacts).values({
          artifactId, accountId: loaded.row.accountId, projectId, kind: body.kind,
          status: 'ready', imageReference: body.image, createdBy: loaded.userId,
        }).returning();
        return c.json({ artifact: serializeArtifact(artifact!), upload: null }, 201);
      }
      let upload: Awaited<ReturnType<typeof createAppArtifactUploadUrl>>;
      try {
        upload = await createAppArtifactUploadUrl(loaded.row.accountId, projectId, artifactId);
      } catch (error) {
        if (error instanceof AppArtifactStorageUnavailableError) {
          return c.json({ error: error.message }, 503);
        }
        throw error;
      }
      const [artifact] = await db.insert(appArtifacts).values({
        artifactId, accountId: loaded.row.accountId, projectId, kind: body.kind,
        status: 'uploading', objectPath: upload.objectPath,
        mediaType: body.media_type ?? 'application/gzip', createdBy: loaded.userId,
      }).returning();
      return c.json({ artifact: serializeArtifact(artifact!), upload: { url: upload.uploadUrl, max_bytes: upload.maxBytes } }, 201);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/artifacts/{artifactId}/finalize', tags: ['apps'], summary: 'Finalize an uploaded artifact', ...auth,
      request: {
        params: z.object({ projectId: z.string().uuid(), artifactId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size_bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES) }) } } },
      },
      responses: { 200: json(ArtifactObject, 'Artifact'), ...errors(400, 403, 404, 409) },
    }),
    async (c: any) => {
      const { projectId, artifactId } = c.req.param();
      const gate = await authorizedProject(c, projectId, 'deploy');
      if (gate instanceof Response) return gate;
      const body = c.req.valid('json');
      const [artifact] = await db.update(appArtifacts).set({
        status: 'uploaded', sha256: body.sha256, sizeBytes: body.size_bytes, updatedAt: new Date(),
      }).where(and(
        eq(appArtifacts.artifactId, artifactId), eq(appArtifacts.projectId, projectId),
        eq(appArtifacts.kind, 'archive'), eq(appArtifacts.status, 'uploading'),
      )).returning();
      if (!artifact) return c.json({ error: 'Artifact is not awaiting finalization' }, 409);
      return c.json(serializeArtifact(artifact));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}', tags: ['apps'], summary: 'Get an App', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
      responses: { 200: json(AppObject, 'App'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await visibleApp(projectId, appId, loaded.userId);
      return row ? c.json(await appJson(row)) : c.json({ error: 'Not found' }, 404);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch', path: '/{projectId}/apps/{appId}', tags: ['apps'], summary: 'Update an App', ...auth,
      description:
        '`uses` replaces the Apps (by slug) this App uses; each must be a live App of the project (400 `app_not_found`). ' +
        'A `convex` App resizes in the background: the answer carries `instance.operation: "resizing"` and the new ' +
        'size shows when it is applied (seconds of downtime, a `resize` snapshot first; disk only grows; 409 `app_busy` ' +
        'while another operation runs). It always runs: `always_on: false` answers 400.',
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({
          name: z.string().min(1).max(200).optional(), cpu: CpuSchema.optional(),
          memory_gb: MemorySchema.optional(), disk_gb: DiskSchema.optional(),
          idle_timeout_seconds: z.number().int().min(120).max(86400).optional(), always_on: z.boolean().optional(), monthly_budget_usd: z.number().min(0).max(100000).optional(),
          uses: UsesSchema.optional(),
        }) } } },
      },
      responses: { 200: json(AppObject, 'App'), ...errors(400, 402, 403, 404, 409, 502, 503) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId, 'write');
      if (loaded instanceof Response) return loaded;
      const current = await visibleApp(projectId, appId, loaded.userId);
      if (!current) {
        return c.json({ error: 'Not found' }, 404);
      }
      const body = c.req.valid('json');
      const convex = current.kind === 'convex';
      if (convex && body.always_on === false) {
        return c.json({ error: 'A convex App always runs; always_on cannot be false.', code: 'app_always_on_required' }, 400);
      }
      try {
        if (!convex) assertAppMachineWithinLimits({ cpu: body.cpu, memoryGb: body.memory_gb, diskGb: body.disk_gb });
        assertAppBudgetWithinLimits(body.monthly_budget_usd);
      } catch (error) {
        const refusal = appLimitResponse(c, error);
        if (refusal) return refusal;
        throw error;
      }
      // A budget nobody set follows the machine and run mode; one a person set never moves.
      const nextMachine = {
        cpuCores: body.cpu ?? current.cpuCores,
        memoryGb: body.memory_gb ?? current.memoryGb,
        diskGb: body.disk_gb ?? current.diskGb,
        alwaysOn: body.always_on ?? current.alwaysOn,
      };
      const sizeChanged = nextMachine.cpuCores !== current.cpuCores || nextMachine.memoryGb !== current.memoryGb
        || nextMachine.diskGb !== current.diskGb;
      // Links first: an unknown slug answers 400 before anything changes.
      const linked = await linkOrRefuse(c, current, body.uses);
      if (linked) return linked;
      if (convex && sizeChanged) {
        const resized = await startConvexResize(c, projectId, current, nextMachine);
        if (resized) return resized;
      }
      const machineChanged = [body.cpu, body.memory_gb, body.disk_gb, body.always_on].some((value) => value !== undefined);
      const derivedBudget = body.monthly_budget_usd === undefined && !current.monthlyBudgetExplicit && machineChanged
        ? defaultAppBudgetUsd(nextMachine, convex ? 'platinum' : config.getDefaultProvider())
        : undefined;
      const [row] = await db.update(apps).set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        // A `convex` App's size is written when the resize applies (kinds/convex/operations.ts runResize).
        ...(body.cpu !== undefined && !convex ? { cpuCores: body.cpu } : {}),
        ...(body.memory_gb !== undefined && !convex ? { memoryGb: body.memory_gb } : {}),
        ...(body.disk_gb !== undefined && !convex ? { diskGb: body.disk_gb } : {}),
        ...(body.idle_timeout_seconds !== undefined ? { idleTimeoutSeconds: body.idle_timeout_seconds } : {}),
        ...(body.always_on !== undefined ? { alwaysOn: body.always_on } : {}),
        ...(body.monthly_budget_usd !== undefined ? { monthlyBudgetUsd: body.monthly_budget_usd.toFixed(2), monthlyBudgetExplicit: true } : {}),
        ...(derivedBudget !== undefined ? { monthlyBudgetUsd: derivedBudget.toFixed(2) } : {}),
        updatedAt: new Date(),
      }).where(and(eq(apps.appId, appId), eq(apps.projectId, projectId), isNull(apps.deletedAt))).returning();
      if (!row) return c.json({ error: 'Not found' }, 404);
      // Warn only when this change touched the run mode, the machine or the budget.
      const costChanged = [body.always_on, body.monthly_budget_usd, body.cpu, body.memory_gb, body.disk_gb]
        .some((value) => value !== undefined);
      const [active] = row.activeDeploymentId
        ? await db.select({ hostingType: appDeployments.hostingType, hostingProvider: appDeployments.hostingProvider })
            .from(appDeployments).where(eq(appDeployments.deploymentId, row.activeDeploymentId)).limit(1)
        : [];
      const warning = costChanged && !convex && active?.hostingType !== 'static'
        ? alwaysOnBudgetWarning(row, (active?.hostingProvider as SandboxProviderName | null) ?? config.getDefaultProvider())
        : null;
      return c.json({ ...(await appJson(row)), warnings: warning ? [warning] : [] });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/apps/{appId}', tags: ['apps'], summary: 'Delete an App', ...auth,
      description:
        'A `web` App stops serving at once; its runtimes and images go. A `convex` App holds data, so its delete needs ' +
        'project.app.admin and the typed slug: `confirm=<slug>` as a query parameter or `{ "confirm": "<slug>" }` as ' +
        'the body (400 `confirmation_required` otherwise). Kortix takes a `final` snapshot, stops the machine and keeps ' +
        'both 7 days (`retained_until`); its hosts answer 410 meanwhile. 409 `app_busy` while a resize, restore, ' +
        'snapshot or credential rotation runs.',
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
        query: z.object({ confirm: z.string().max(63).optional() }),
      },
      responses: {
        200: json(z.object({
          ok: z.boolean(),
          images: ImageReleaseObject,
          retained_until: z.string().nullable().optional(),
          final_snapshot_id: z.string().nullable().optional(),
        }), 'Deleted'),
        ...errors(400, 403, 404, 409, 502),
      },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId, 'write');
      if (loaded instanceof Response) return loaded;
      const row = await visibleApp(projectId, appId, loaded.userId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      if (row.kind === 'convex') return deleteConvexApp(c, projectId, row);
      // Delete first, tear down second. A deleted App stops routing and leaves
      // the idle reaper at once; if this request dies mid-teardown, project
      // maintenance (`reclaimAppDeploymentImages`) removes what it left behind.
      await db.update(apps).set({ deletedAt: new Date(), desiredState: 'stopped', activeDeploymentId: null, updatedAt: new Date() })
        .where(eq(apps.appId, appId));
      const deployments = await db
        .select({
          deploymentId: appDeployments.deploymentId,
          hostingProvider: appDeployments.hostingProvider,
          providerBuildId: appDeployments.providerBuildId,
          status: appDeployments.status,
        })
        .from(appDeployments)
        .where(eq(appDeployments.appId, appId));
      // Static files: the manifests go now, so `reclaimAppSiteBlobs` frees the
      // blobs after its grace. A publish still running writes after this; the
      // retention sweep drops those rows (the App is deleted).
      if (deployments.length > 0) {
        await db.delete(appSiteFiles).where(inArray(appSiteFiles.deploymentId, deployments.map((d) => d.deploymentId)));
      }
      const runtimes = await db
        .select({ runtimeId: appRuntimes.runtimeId, provider: appRuntimes.provider, externalId: appRuntimes.externalId })
        .from(appRuntimes)
        .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
        .where(and(eq(appDeployments.appId, appId), ne(appRuntimes.status, 'deleted')));
      // A runtime's provider may since have been disabled or retired; removal
      // then counts it gone (`removeAppRuntime`), so a dead provider never blocks
      // the delete. Its compute meter closes either way.
      await teardownAppRuntimes(runtimes);
      // Each deployment build left one provider image. Platinum counts them
      // against a per-org template cap, so the App is not gone until they are.
      // A build still running may register its image after this request, so it
      // is reported pending, never released; maintenance reclaims it once the
      // worker stops (the worker refuses to start a runtime for a deleted App).
      const building = deployments.filter((deployment) =>
        deployment.hostingProvider && IN_PROGRESS_DEPLOYMENT_STATUSES.includes(deployment.status));
      // A deployment its owner already deleted released (or queued) its image
      // then; counting it again would report one image as freed twice. Any of
      // those still pending is retried by maintenance.
      const finished = deployments.filter((deployment) =>
        deployment.status !== 'deleted' && !IN_PROGRESS_DEPLOYMENT_STATUSES.includes(deployment.status));
      const released = await releaseDeploymentImages(finished);
      const images = { released: released.released, pending: released.pending + building.length };
      return c.json({ ok: true, images });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/deployments', tags: ['apps'], summary: 'Deploy an App', ...auth,
      description:
        'A `web` App: queue a build of an uploaded artifact (`artifact_id` + `source`); answers 202. A `convex` App: ' +
        'the client CLI deploys the functions itself, then records the deployment here with `source: { kind: "convex", ' +
        'revision? }` and no artifact; answers 201 with a `ready` deployment, so the history shows who deployed what.',
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({
          artifact_id: z.string().uuid().optional(),
          source: z.union([SourceSchema, ConvexSourceSchema]),
          provider: z.enum(['daytona', 'platinum', 'e2b']).optional(),
          environment: EnvironmentSchema.optional(),
          secrets: SecretMappingsSchema.optional(),
        }) } } },
      },
      responses: {
        201: json(DeploymentObject, 'Deployment recorded (convex)'),
        202: json(DeploymentObject, 'Deployment queued'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId, 'deploy');
      if (loaded instanceof Response) return loaded;
      const app = await visibleApp(projectId, appId, loaded.userId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      const body = c.req.valid('json');
      if ((app.kind === 'convex') !== (body.source.kind === 'convex')) {
        return c.json({
          error: app.kind === 'convex'
            ? 'A convex App records its deployments with source.kind "convex".'
            : 'source.kind "convex" deploys only to a convex App.',
          code: 'source_kind_mismatch',
        }, 400);
      }
      if (body.source.kind === 'convex') {
        if (body.artifact_id) return c.json({ error: 'A convex deployment has no artifact.', code: 'source_kind_mismatch' }, 400);
        const recorded = await recordConvexDeployment(c, appId, loaded.userId, body.source.revision ?? null);
        return c.json(serializeDeployment(recorded), 201);
      }
      if (!body.artifact_id) return c.json({ error: 'artifact_id is required' }, 400);
      const [artifact] = await db.select().from(appArtifacts).where(and(
        eq(appArtifacts.artifactId, body.artifact_id), eq(appArtifacts.projectId, projectId),
      )).limit(1);
      if (!artifact || !['uploaded', 'ready'].includes(artifact.status)) return c.json({ error: 'Artifact is not ready to deploy' }, 409);
      if (artifact.kind === 'oci_image' && body.source.kind !== 'oci_image') return c.json({ error: 'OCI artifacts require an oci_image source' }, 400);
      if (artifact.kind === 'archive' && body.source.kind === 'oci_image') return c.json({ error: 'Archive artifacts cannot use an oci_image source' }, 400);
      if (body.source.kind === 'oci_image' && body.source.image !== artifact.imageReference) return c.json({ error: 'source.image must match the immutable artifact image' }, 400);
      const source = sourceFromWire(body.source);
      const deployment = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId}))`);
        const [versionRow] = await tx.select({ value: max(appDeployments.version) }).from(appDeployments)
          .where(eq(appDeployments.appId, appId));
        const version = Number(versionRow?.value ?? 0) + 1;
        const [row] = await tx.insert(appDeployments).values({
          appId, artifactId: artifact.artifactId, version, status: 'queued',
          sourceKind: source.kind, hostingProvider: body.provider ?? null,
          createdBy: loaded.userId,
          sourceSessionId: callerKortixSessionId(c),
          actorType: appDeploymentActorType(c),
          runtimeVersion: APP_RUNTIME_VERSION,
          buildSpec: {
            source,
            environment: body.environment ?? {},
            secrets: body.secrets ?? {},
          },
          runtimeSpec: {},
        }).returning();
        return row!;
      });
      triggerAppDeploymentWorker();
      return c.json(serializeDeployment(deployment), 202);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/deployments', tags: ['apps'], summary: 'List App deployments', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
      responses: { 200: json(z.object({ deployments: z.array(DeploymentObject) }), 'Deployments'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      if (!(await visibleApp(projectId, appId, loaded.userId))) {
        return c.json({ error: 'Not found' }, 404);
      }
      const rows = await db.select().from(appDeployments)
        .where(and(eq(appDeployments.appId, appId), ne(appDeployments.status, 'deleted')))
        .orderBy(desc(appDeployments.version));
      return c.json({ deployments: rows.map(serializeDeployment) });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/deployments/{deploymentId}', tags: ['apps'], summary: 'Get App deployment', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid(), deploymentId: z.string().uuid() }) },
      responses: { 200: json(z.object({ deployment: DeploymentObject, events: z.array(z.object({}).passthrough()) }), 'Deployment'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const { projectId, appId, deploymentId } = c.req.param();
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      if (!(await visibleApp(projectId, appId, loaded.userId))) {
        return c.json({ error: 'Not found' }, 404);
      }
      const [deployment] = await db.select().from(appDeployments).where(and(
        eq(appDeployments.deploymentId, deploymentId),
        eq(appDeployments.appId, appId),
        ne(appDeployments.status, 'deleted'),
      )).limit(1);
      if (!deployment) return c.json({ error: 'Not found' }, 404);
      const events = await db.select().from(appDeploymentEvents).where(eq(appDeploymentEvents.deploymentId, deploymentId)).orderBy(appDeploymentEvents.createdAt);
      return c.json({ deployment: serializeDeployment(deployment), events: events.map((row) => ({
        event_id: row.eventId, runtime_id: row.runtimeId, level: row.level, type: row.type,
        message: row.message, data: row.data, created_at: row.createdAt.toISOString(),
      })) });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/deployments/{deploymentId}/logs', tags: ['apps'], summary: 'Get App runtime logs', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid(), deploymentId: z.string().uuid() }), query: z.object({ after: z.string().optional(), limit: z.string().optional() }) },
      responses: { 200: json(z.object({}).passthrough(), 'Logs'), ...errors(403, 404, 409, 503) },
    }),
    async (c: any) => {
      const { projectId, appId, deploymentId } = c.req.param();
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      if (!(await visibleApp(projectId, appId, loaded.userId))) {
        return c.json({ error: 'Not found' }, 404);
      }
      const [deployment] = await db.select().from(appDeployments).where(and(
        eq(appDeployments.deploymentId, deploymentId),
        eq(appDeployments.appId, appId),
        ne(appDeployments.status, 'deleted'),
      )).limit(1);
      if (!deployment) return c.json({ error: 'Not found' }, 404);
      const eventFallback = async () => {
        const events = await db.select({
          type: appDeploymentEvents.type,
          message: appDeploymentEvents.message,
          createdAt: appDeploymentEvents.createdAt,
        }).from(appDeploymentEvents)
          .where(eq(appDeploymentEvents.deploymentId, deploymentId))
          .orderBy(appDeploymentEvents.createdAt);
        return deploymentEventsAsLogs(
          events,
          Number(c.req.query('after')) || 0,
          Number(c.req.query('limit')) || 200,
        );
      };
      const [row] = await db.select().from(appRuntimes)
        .where(eq(appRuntimes.deploymentId, deploymentId))
        .orderBy(desc(appRuntimes.createdAt)).limit(1);
      if (!row) return c.json(await eventFallback());
      if (row.status === 'stopped' || row.status === 'error' || row.status === 'deleted') {
        return c.json(await eventFallback());
      }
      try {
        const logs = await new AppHostingProvider().logs(row.provider as SandboxProviderName, row.externalId, row.runtimeId, Number(c.req.query('after')) || 0, Number(c.req.query('limit')) || 200);
        return c.json(logs);
      } catch (error) {
        console.warn(`[apps] logs unavailable for runtime ${row.runtimeId}:`, error);
        return c.json(await eventFallback());
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/apps/{appId}/deployments/{deploymentId}', tags: ['apps'], summary: 'Delete an App deployment', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid(), deploymentId: z.string().uuid() }) },
      responses: {
        200: json(z.object({
          ok: z.boolean(),
          deployment_id: z.string().uuid(),
          image: z.enum(['released', 'pending', 'none']),
        }), 'Deleted'),
        ...errors(403, 404, 409),
      },
    }),
    async (c: any) => {
      const { projectId, appId, deploymentId } = c.req.param();
      const loaded = await authorizedProject(c, projectId, 'write');
      if (loaded instanceof Response) return loaded;
      if (!(await visibleApp(projectId, appId, loaded.userId))) {
        return c.json({ error: 'Not found' }, 404);
      }
      const decision = await db.transaction(async (tx) => {
        // Deploy creation takes the same lock, and the App row lock orders this
        // against an activation or rollback moving the live pointer.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId}))`);
        const [app] = await tx.select({ activeDeploymentId: apps.activeDeploymentId })
          .from(apps)
          .where(and(eq(apps.appId, appId), isNull(apps.deletedAt)))
          .for('update')
          .limit(1);
        if (!app) return { kind: 'missing' as const };
        const [deployment] = await tx.select().from(appDeployments).where(and(
          eq(appDeployments.deploymentId, deploymentId),
          eq(appDeployments.appId, appId),
          ne(appDeployments.status, 'deleted'),
        )).limit(1);
        if (!deployment) return { kind: 'missing' as const };
        if (app.activeDeploymentId === deploymentId) return { kind: 'live' as const };
        if (IN_PROGRESS_DEPLOYMENT_STATUSES.includes(deployment.status)) {
          return { kind: 'in_progress' as const, status: deployment.status };
        }
        await tx.update(appDeployments)
          .set({ status: 'deleted', updatedAt: new Date() })
          .where(and(
            eq(appDeployments.deploymentId, deploymentId),
            notInArray(appDeployments.status, [...IN_PROGRESS_DEPLOYMENT_STATUSES, 'deleted']),
          ));
        return {
          kind: 'deleted' as const,
          hostingProvider: deployment.hostingProvider,
          providerBuildId: deployment.providerBuildId,
        };
      });
      if (decision.kind === 'missing') return c.json({ error: 'Not found' }, 404);
      if (decision.kind === 'live') {
        return c.json({
          error: 'This deployment serves live traffic. Roll back to another deployment first, or delete the App.',
          code: 'deployment_live',
        }, 409);
      }
      if (decision.kind === 'in_progress') {
        return c.json({
          error: `This deployment is still in progress (status: ${decision.status}). Delete it after it finishes or fails.`,
          code: 'deployment_in_progress',
          status: decision.status,
        }, 409);
      }

      const runtimes = await db
        .select({ runtimeId: appRuntimes.runtimeId, provider: appRuntimes.provider, externalId: appRuntimes.externalId })
        .from(appRuntimes)
        .where(and(eq(appRuntimes.deploymentId, deploymentId), ne(appRuntimes.status, 'deleted')));
      // Platinum refuses to delete an image while a sandbox pins it, so the
      // runtime goes first. Anything left `pending` is retried by maintenance.
      await teardownAppRuntimes(runtimes);
      // A shared image another deployment still uses stays; the outcome is then `none`.
      const image = await releaseDeploymentImage({
        deploymentId,
        hostingProvider: decision.hostingProvider,
        providerBuildId: decision.providerBuildId,
      });
      await db.delete(appSiteFiles).where(eq(appSiteFiles.deploymentId, deploymentId));
      await db.insert(appDeploymentEvents).values({
        deploymentId,
        type: 'deployment_deleted',
        message: 'Deployment deleted by its owner',
        data: { image, userId: loaded.userId },
      });
      return c.json({ ok: true, deployment_id: deploymentId, image });
    },
  );

  for (const action of ['start', 'stop'] as const) {
    projectsApp.openapi(
      createRoute({
        method: 'post', path: `/{projectId}/apps/{appId}/${action}`, tags: ['apps'], summary: `${action} an App`, ...auth,
        request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
        responses: { 200: json(AppObject, 'App'), ...errors(402, 403, 404, 409, 429, 503) },
      }),
      async (c: any) => {
        const { projectId, appId } = c.req.param();
        const loaded = await authorizedProject(c, projectId, 'deploy');
        if (loaded instanceof Response) return loaded;
        const app = await visibleApp(projectId, appId, loaded.userId);
        if (!app) return c.json({ error: 'Not found' }, 404);
        // A kind that never sleeps (`convex`) has nothing to start or stop.
        const refusal = app.kind === 'web' ? null : capabilityRefusal(c, app, 'sleep');
        if (refusal) return refusal;
        if (!app.activeDeploymentId) return c.json({ error: 'App has no active deployment' }, 409);
        const [active] = await db.select({ hostingType: appDeployments.hostingType }).from(appDeployments)
          .where(eq(appDeployments.deploymentId, app.activeDeploymentId)).limit(1);
        if (active?.hostingType === 'static') {
          // Served from storage: there is no runtime to start or stop. The
          // static path ignores desired_state, so writing it would only make
          // the App read "stopped" while it serves. Unpublish = delete the App.
          return c.json({
            error: 'A static App has no runtime to start or stop. It serves while it has an active deployment; delete the App to take it offline.',
            code: 'static_app_no_runtime',
          }, 409);
        }
        const [row] = await db.update(apps).set({ desiredState: action === 'start' ? 'running' : 'stopped', updatedAt: new Date() }).where(eq(apps.appId, appId)).returning();
        if (action === 'stop') {
          const [runtime] = await db.select().from(appRuntimes).where(and(
            eq(appRuntimes.deploymentId, app.activeDeploymentId),
            inArray(appRuntimes.status, ['starting', 'running']),
          )).orderBy(desc(appRuntimes.createdAt)).limit(1);
          if (runtime) {
            await new AppHostingProvider().stop(runtime.provider as SandboxProviderName, runtime.externalId);
            const now = new Date();
            await db.update(appRuntimes).set({
              status: 'stopped',
              stoppedAt: now,
              activityLeaseUntil: null,
              idleDeadlineAt: null,
              wakeLeaseOwner: null,
              wakeLeaseUntil: null,
              updatedAt: now,
            }).where(eq(appRuntimes.runtimeId, runtime.runtimeId));
            await pauseComputeSession(runtime.runtimeId, now);
          }
        } else {
          const loaded = await loadPublicApp(app.routeKey);
          if (!loaded) return c.json({ error: 'Active deployment has no runtime' }, 409);
          try {
            await ensureAppRuntimeRunning(loaded, new AppHostingProvider());
          } catch (error) {
            await db.update(apps).set({ desiredState: app.desiredState, updatedAt: new Date() })
              .where(eq(apps.appId, appId));
            if (error instanceof Response) {
              return c.json(await error.json(), error.status as 402 | 409 | 503);
            }
            const refusal = appLimitResponse(c, error);
            if (refusal) return refusal;
            return c.json({
              error: 'App start failed',
              detail: error instanceof Error ? error.message : String(error),
            }, 503);
          }
        }
        return c.json(await appJson(row!));
      },
    );
  }

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/rollback', tags: ['apps'], summary: 'Roll back an App', ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }), body: { content: { 'application/json': { schema: z.object({ deployment_id: z.string().uuid() }) } } } },
      responses: { 200: json(AppObject, 'App'), ...errors(402, 403, 404, 409, 429, 503) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId, 'deploy');
      if (loaded instanceof Response) return loaded;
      const app = await visibleApp(projectId, appId, loaded.userId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      const refusal = capabilityRefusal(c, app, 'rollback');
      if (refusal) return refusal;
      const { deployment_id: deploymentId } = c.req.valid('json');
      const [deployment] = await db.select().from(appDeployments).where(and(eq(appDeployments.deploymentId, deploymentId), eq(appDeployments.appId, appId), eq(appDeployments.status, 'ready'))).limit(1);
      if (!deployment) return c.json({ error: 'Only a ready deployment can receive rollback traffic' }, 409);
      // A static deployment is served from storage: nothing to start.
      const isStatic = deployment.hostingType === 'static';
      const [targetRuntime] = isStatic ? [] : await db.select().from(appRuntimes)
        .where(eq(appRuntimes.deploymentId, deploymentId))
        .orderBy(desc(appRuntimes.createdAt))
        .limit(1);
      if (!isStatic && !targetRuntime) return c.json({ error: 'Rollback deployment has no runtime' }, 409);

      const [runningApp] = await db.update(apps)
        .set({ desiredState: 'running', updatedAt: new Date() })
        .where(eq(apps.appId, appId))
        .returning();
      const hosting = new AppHostingProvider();
      try {
        if (targetRuntime) await ensureAppRuntimeRunning({ app: runningApp!, deployment, runtime: targetRuntime }, hosting);
      } catch (error) {
        await db.update(apps).set({ desiredState: app.desiredState, updatedAt: new Date() })
          .where(eq(apps.appId, appId));
        if (error instanceof Response) return c.json(await error.json(), error.status as 402 | 409 | 503);
        const refusal = appLimitResponse(c, error);
        if (refusal) return refusal;
        return c.json({
          error: 'Rollback runtime failed to start',
          detail: error instanceof Error ? error.message : String(error),
        }, 503);
      }

      const previousDeploymentId = app.activeDeploymentId;
      // A concurrent delete or retention can retire the target after the ready
      // check above. Move traffic only while the target is still ready.
      const row = await rollBackActiveDeployment(appId, deploymentId);
      if (!row) return c.json({ error: 'The rollback deployment was deleted' }, 409);
      await db.insert(appDeploymentEvents).values({
        deploymentId,
        runtimeId: targetRuntime?.runtimeId ?? null,
        type: 'deployment_rollback',
        message: 'Rollback deployment is serving traffic',
        data: { previousDeploymentId },
      });
      if (previousDeploymentId && previousDeploymentId !== deploymentId) {
        const [previousRuntime] = await db.select().from(appRuntimes)
          .where(and(
            eq(appRuntimes.deploymentId, previousDeploymentId),
            inArray(appRuntimes.status, ['starting', 'running']),
          ))
          .orderBy(desc(appRuntimes.createdAt))
          .limit(1);
        if (previousRuntime) {
          await hosting.stop(previousRuntime.provider as SandboxProviderName, previousRuntime.externalId);
          const stoppedAt = new Date();
          await db.update(appRuntimes)
            .set({ status: 'stopped', stoppedAt, updatedAt: stoppedAt })
            .where(eq(appRuntimes.runtimeId, previousRuntime.runtimeId));
          await pauseComputeSession(previousRuntime.runtimeId, stoppedAt);
        }
      }
      return c.json(await appJson(row!));
    },
  );
}
