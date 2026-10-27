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
import { and, desc, eq, inArray, isNotNull, isNull, max, ne, notInArray, sql } from 'drizzle-orm';
import { auth, boundedIssues, errors, json } from '../openapi';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { db } from '../shared/db';
import { inspectDatabaseError } from '../shared/database-errors';
import {
  AppArtifactStorageRefusedError,
  AppArtifactStorageUnavailableError,
  createAppArtifactUploadUrl,
  MAX_ARCHIVE_BYTES,
} from './artifacts';
import { APP_RUNTIME_VERSION, triggerAppDeploymentWorker } from './deployment-worker';
import { AppHostingProvider } from './hosting';
import { deploymentEventsAsLogs } from './logs';
import { releaseDeploymentImage, releaseDeploymentImages, teardownAppRuntimes } from './images';
import { ReleaseConfigSchema, resolveDeployConfig } from './release-config';
import { chooseReleaseProvider, destroyAppVolumes, listAppVolumes } from './volumes';
import { ensureAppRuntimeRunning, loadPublicApp } from './public-proxy';
import { type AppSourceSpec } from './spec';
import { appPublicUrl } from './hostnames';
import {
  APP_MACHINE_LIMITS,
  AppAccountUnfundedError,
  AppLimitError,
  assertAppMachineWithinLimits,
  assertAppQuotaAvailable,
} from './limits';
import { callerKortixSessionId } from '../middleware/caller-session';
import { projectsApp } from '../projects/lib/app';
import { logger } from '../lib/logger';
import { readAgentsGrantingApp } from './agent-grants';
import {
  appAccessibleToUser,
  appAccessSessionUrl,
  persistAppAccessPolicy,
  serializeAppAccessPolicy,
  validateAppAccessPrincipals,
} from './access';
import { authorizedProject, capabilityRefusal, visibleApp } from './route-access';
import { AppObject, appJson, appsJson } from './serialize';
import { accessibleApps } from './space-apps';
import { commitAppFields, commitAppRemoval, manifestFieldsOf } from './app-manifest';
import { probeFrameable } from './external';
import { UnknownLinkedAppError, resolveAppLinks, writeAppLinks } from './links';
import { registerAppCapabilityRoutes } from './capability-routes';
import { registerAppFleetRoutes } from './fleet-routes';
import {
  DEPRECATED_PROVIDER_CODE,
  DEPRECATED_PROVIDER_ERROR,
  isDeprecatedProvider,
} from '../platform/providers/deprecated';

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
 * sign-in tokens. Each must exist and be visible to the caller. Empty, the default: none.
 */
const UsesSchema = z
  .array(z.string().regex(APP_SLUG, 'an App slug: lowercase letters, numbers and single hyphens'))
  .max(20)
  .transform((slugs) => [...new Set(slugs)]);
/** Where Kortix shows the App (`AppDisplay`). Replaced whole; `{}` restores the defaults. */
const DisplaySchema = z.object({
  listed: z.boolean().optional(),
  preview: z.enum(['live', 'none']).optional(),
  parent: z.string().regex(APP_SLUG, 'an App slug').optional(),
}).strict();
/** An external App's site: https only, no credentials in the URL. */
const ExternalUrlSchema = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'an https URL without credentials');

/** The create/PATCH warning for a site that refuses to be framed. */
function framingWarnings(url: string, frameable: boolean): Array<{ code: string; message: string }> {
  if (frameable) return [];
  return [{
    code: 'app_external_not_frameable',
    message: `${new URL(url).host} does not allow other sites to frame it. Kortix opens it in a new tab.`,
  }];
}

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
    /** The primary service's port; omitted for a worker-only App (process groups, no service). */
    port: z.number().int().optional(),
    readiness_path: z.string().optional(),
    restart_limit: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('oci_image'),
    image: z.string(),
    command: z.array(z.string()).min(1),
    /** The primary service's port; omitted for a worker-only App (process groups, no service). */
    port: z.number().int().optional(),
    readiness_path: z.string().optional(),
    restart_limit: z.number().int().optional(),
  }),
]);

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
    /** The release config, its deploy strategy and the release command's outcome. */
    config: row.config,
    strategy: row.strategy,
    release_command_status: row.releaseCommandStatus,
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
 * The Apps `uses` names, resolved among the live Apps of the project that
 * `userId` can see; the 400 `app_not_found` to answer for any other slug
 * (a missing App and one the caller cannot see answer alike). Writes nothing.
 */
async function resolveLinksOrRefuse(
  c: Context<AppEnv>,
  app: typeof apps.$inferSelect,
  uses: string[],
  userId: string,
): Promise<Array<{ appId: string }> | Response> {
  try {
    return await resolveAppLinks(app, uses, userId);
  } catch (error) {
    if (!(error instanceof UnknownLinkedAppError)) throw error;
    return c.json({ error: error.message, code: 'app_not_found', slugs: error.slugs }, 400);
  }
}

/** Sets the Apps a just-created App uses; the 400 to answer when a slug names no App the caller can see. */
async function linkOrRefuse(c: Context<AppEnv>, app: typeof apps.$inferSelect, uses: string[], userId: string): Promise<Response | null> {
  const found = await resolveLinksOrRefuse(c, app, uses, userId);
  if (found instanceof Response) return found;
  await db.transaction((tx) => writeAppLinks(tx, app.appId, found));
  return null;
}

export function registerAppsRoutes(): void {
  registerAppCapabilityRoutes();
  registerAppFleetRoutes();
  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps', tags: ['apps'], summary: 'List Apps', ...auth,
      description: 'Only the Apps the caller may open under each App\'s access policy (a project manager: every App). ' +
        'An App left out answers 404 on GET, the same as a missing one.',
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
      // Only the Apps the caller may see AND open: no card that is listed and
      // then refuses to open. An App left out answers 404 on GET, never 403.
      const accessible = await accessibleApps(rows, loaded.userId);
      return c.json({ apps: await appsJson(accessible.rows, loaded.userId, accessible.openable) });
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
      const loaded = await authorizedProject(c, projectId, 'write');
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
      // An external App opens in a new tab when its site refuses a frame, so
      // its URL is handed out whether or not it can be previewed.
      const refusal = row.externalUrl ? null : capabilityRefusal(c, 'preview');
      if (refusal) return refusal;
      if (row.accessMode !== 'public' && row.accessMode !== 'password' && !(await appAccessibleToUser(row, loaded.userId))) {
        return c.json({ error: 'App access denied' }, 403);
      }
      // Hosted elsewhere: its own site signs people in. Kortix only decides who sees it.
      if (row.externalUrl) {
        return c.json({ url: row.externalUrl, expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString() });
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
      description: 'Account credits pay for App compute: there is no per-App budget. `external_url` (https) creates an ' +
        'external App: Kortix lists and frames that site and never deploys it. It runs no compute and does not count ' +
        'toward the App limit. A site that refuses framing (X-Frame-Options, CSP frame-ancestors) gets ' +
        '`capabilities: []` and a warning: Kortix opens it in a new tab.',
      request: {
        params: z.object({ projectId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({
          slug: z.string().min(1).max(63), name: z.string().min(1).max(200),
          cpu: CpuSchema.optional(),
          memory_gb: MemorySchema.optional(),
          disk_gb: DiskSchema.optional(),
          idle_timeout_seconds: z.number().int().min(120).max(86400).default(300),
          always_on: z.boolean().optional(),
          uses: UsesSchema.default([]),
          external_url: ExternalUrlSchema.optional(),
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
      const machine = { cpu: body.cpu ?? 1, memoryGb: body.memory_gb ?? 2, diskGb: body.disk_gb ?? 10 };
      const externalUrl: string | null = body.external_url ?? null;
      if (!externalUrl) {
        try {
          assertAppMachineWithinLimits(machine);
          await assertAppQuotaAvailable(loaded.row.accountId);
        } catch (error) {
          const refusal = appLimitResponse(c, error);
          if (refusal) return refusal;
          throw error;
        }
      }
      const externalFrameable = externalUrl ? await probeFrameable(externalUrl, config.FRONTEND_URL) : false;
      // kortix.yaml owns the declarable fields: what the request sets explicitly
      // is committed to apps.<slug> before the row exists. An external App is
      // declared listed, so the file says it is on the Apps page.
      // Nothing reaches kortix.yaml before the request is known to be allowed:
      // a slug another App holds is a 409 here (or the commit would rewrite that
      // App's declared settings), and every `uses` link passes the visibility
      // check first (or the next sync would apply a link the caller may not make).
      const [taken] = await db.select({ appId: apps.appId }).from(apps)
        .where(and(eq(apps.projectId, projectId), eq(apps.slug, slug), isNull(apps.deletedAt))).limit(1);
      if (taken) return c.json({ error: 'An App with this slug already exists' }, 409);
      if (body.uses.length) {
        try {
          await resolveAppLinks({ projectId, slug }, body.uses, loaded.userId);
        } catch (error) {
          if (!(error instanceof UnknownLinkedAppError)) throw error;
          return c.json({ error: error.message, code: 'app_not_found', slugs: error.slugs }, 400);
        }
      }
      const declared = await commitAppFields(projectId, slug, {
        ...manifestFieldsOf({ cpu: body.cpu, memory_gb: body.memory_gb, disk_gb: body.disk_gb, always_on: body.always_on }),
        ...(body.uses.length ? { uses: body.uses } : {}),
        ...(externalUrl ? { display: { listed: true } } : {}),
      });
      if (!declared.ok) return c.json({ error: declared.error, code: declared.code ?? 'manifest_write_failed' }, declared.status);
      let row: typeof apps.$inferSelect;
      try {
        const alwaysOn = body.always_on ?? config.KORTIX_APPS_DEFAULT_ALWAYS_ON;
        [row] = (await db.insert(apps).values({
          accountId: loaded.row.accountId, projectId, slug, name: body.name.trim(),
          routeKey: randomBytes(8).toString('hex'), createdBy: loaded.userId,
          cpuCores: machine.cpu, memoryGb: machine.memoryGb, diskGb: machine.diskGb,
          idleTimeoutSeconds: body.idle_timeout_seconds,
          alwaysOn,
          externalUrl,
          externalFrameable,
          // An external App exists to be shown: it is on the Apps page from the start.
          ...(externalUrl ? { display: { listed: true } } : {}),
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
      const linked = body.uses.length ? await linkOrRefuse(c, row, body.uses, loaded.userId) : null;
      if (linked) {
        await db.delete(apps).where(eq(apps.appId, row.appId));
        return linked;
      }
      const warnings = externalUrl ? framingWarnings(externalUrl, externalFrameable) : [];
      return c.json({ ...(await appJson(row, loaded.userId)), warnings }, 201);
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
      responses: { 201: json(z.object({ artifact: ArtifactObject, upload: z.object({ url: z.string(), max_bytes: z.number() }).nullable() }), 'Artifact'), ...errors(400, 403, 404, 500, 503) },
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
        // The Storage status and message go to the log either way (KRTX-2981).
        const cause = (error as { cause?: { status?: unknown; statusCode?: unknown; message?: unknown } }).cause;
        const detail = { status: cause?.status ?? null, statusCode: cause?.statusCode ?? null, message: cause?.message ?? null };
        if (error instanceof AppArtifactStorageRefusedError) {
          logger.error('[apps] artifact storage refused the upload', detail);
          return c.json({ error: error.message }, 500);
        }
        if (error instanceof AppArtifactStorageUnavailableError) {
          logger.warn('[apps] artifact storage unavailable', detail);
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
      return row ? c.json(await appJson(row, loaded.userId)) : c.json({ error: 'Not found' }, 404);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch', path: '/{projectId}/apps/{appId}', tags: ['apps'], summary: 'Update an App', ...auth,
      description:
        '`external_url` moves an external App to another https URL (409 for an App Kortix runs). `display` replaces where Kortix shows the App (`listed`, `preview`: live | none, `parent`: the App whose detail shows it as a tab); presentation only. `uses` replaces the Apps (by slug) this App uses; each must be a live App of the project the caller can see (400 `app_not_found` otherwise, the same for a missing App and a hidden one). A refused PATCH changes nothing. ',
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({
          name: z.string().min(1).max(200).optional(), cpu: CpuSchema.optional(),
          memory_gb: MemorySchema.optional(), disk_gb: DiskSchema.optional(),
          idle_timeout_seconds: z.number().int().min(120).max(86400).optional(), always_on: z.boolean().optional(),
          uses: UsesSchema.optional(),
          labels: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/)).max(10).optional(),
          display: DisplaySchema.optional(),
          external_url: ExternalUrlSchema.optional(),
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
      if (body.external_url !== undefined && !current.externalUrl) {
        return c.json({ error: 'Only an external App has an external_url. Create a new App with external_url instead.', code: 'app_not_external' }, 409);
      }
      const externalFrameable = body.external_url !== undefined
        ? await probeFrameable(body.external_url, config.FRONTEND_URL)
        : undefined;
      const nextMachine = {
        cpuCores: body.cpu ?? current.cpuCores,
        memoryGb: body.memory_gb ?? current.memoryGb,
        diskGb: body.disk_gb ?? current.diskGb,
        alwaysOn: body.always_on ?? current.alwaysOn,
      };
      try {
        assertAppMachineWithinLimits({ cpu: body.cpu, memoryGb: body.memory_gb, diskGb: body.disk_gb });
      } catch (error) {
        const refusal = appLimitResponse(c, error);
        if (refusal) return refusal;
        throw error;
      }
      const sizeChanged = nextMachine.cpuCores !== current.cpuCores || nextMachine.memoryGb !== current.memoryGb
        || nextMachine.diskGb !== current.diskGb;
      // Every refusal comes before any write: the links resolve (400), the
      // resize claims its operation (402/409), then one transaction writes the
      // links and the row, so a refused PATCH changes nothing.
      const links = body.uses === undefined ? undefined : await resolveLinksOrRefuse(c, current, body.uses, loaded.userId);
      if (links instanceof Response) return links;
      // kortix.yaml owns these fields: commit them to apps.<slug> first; a
      // refused commit writes nothing, so the row never disagrees with the file.
      const declared = await commitAppFields(projectId, current.slug, manifestFieldsOf(body));
      if (!declared.ok) return c.json({ error: declared.error, code: declared.code ?? 'manifest_write_failed' }, declared.status);
      const [row] = await db.transaction(async (tx) => {
        if (links) await writeAppLinks(tx, appId, links);
        return tx.update(apps).set({
          ...(body.name !== undefined ? { name: body.name.trim() } : {}),
          ...(body.cpu !== undefined ? { cpuCores: body.cpu } : {}),
          ...(body.memory_gb !== undefined ? { memoryGb: body.memory_gb } : {}),
          ...(body.disk_gb !== undefined ? { diskGb: body.disk_gb } : {}),
          ...(body.idle_timeout_seconds !== undefined ? { idleTimeoutSeconds: body.idle_timeout_seconds } : {}),
          ...(body.always_on !== undefined ? { alwaysOn: body.always_on } : {}),
          ...(body.labels !== undefined ? { labels: [...new Set(body.labels as string[])] } : {}),
          ...(body.display !== undefined ? { display: body.display } : {}),
          ...(body.external_url !== undefined ? { externalUrl: body.external_url, externalFrameable } : {}),
          updatedAt: new Date(),
        }).where(and(eq(apps.appId, appId), eq(apps.projectId, projectId), isNull(apps.deletedAt))).returning();
      });
      if (!row) return c.json({ error: 'Not found' }, 404);
      const warnings = body.external_url !== undefined ? framingWarnings(body.external_url, externalFrameable!) : [];
      return c.json({ ...(await appJson(row, loaded.userId)), warnings });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/apps/{appId}', tags: ['apps'], summary: 'Delete an App', ...auth,
      description:
        'The App stops serving at once; its machines and images go. An App with volumes needs `project.app.admin`: ' +
        'each volume keeps a final snapshot for 7 days, then Kortix purges it.',
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
      },
      responses: {
        200: json(z.object({ ok: z.boolean(), images: ImageReleaseObject }), 'Deleted'),
        ...errors(400, 403, 404, 409, 502),
      },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId, 'write');
      if (loaded instanceof Response) return loaded;
      const row = await visibleApp(projectId, appId, loaded.userId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      // Deleting an App destroys its volumes: the same power as `volumes destroy`.
      if ((await listAppVolumes(appId)).length > 0) {
        const admin = await authorizedProject(c, projectId, 'admin');
        if (admin instanceof Response) return admin;
      }
      // kortix.yaml owns the App's block: remove it (and references to it) first,
      // or the next `kortix apps deploy` would recreate the App from it.
      const undeclared = await commitAppRemoval(projectId, row.slug);
      if (!undeclared.ok) return c.json({ error: undeclared.error, code: undeclared.code ?? 'manifest_write_failed' }, undeclared.status);
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
      // Volumes leave with the App: a final snapshot each, purged after 7 days.
      await destroyAppVolumes(appId);
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
        'Queue a release of an uploaded artifact (`artifact_id` + `source`); answers 202. `config` is the release ' +
        'config (processes, http_service, services, mounts, vm, deploy; the shorthands port, ' +
        'command, readiness_path, always_on and resources map onto it). Without it the release runs one `app` ' +
        'process group on the source port, sized like the App. An invalid config answers 400 `app_config_invalid` ' +
        'with `issues: [{path, message}]`; a mount on a provider without volumes answers 400 `app_volumes_unsupported`.',
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({
          artifact_id: z.string().uuid().optional(),
          source: SourceSchema,
          provider: z.enum(['platinum', 'daytona']).optional(),
          environment: EnvironmentSchema.optional(),
          secrets: SecretMappingsSchema.optional(),
          config: ReleaseConfigSchema.optional(),
        }) } } },
      },
      responses: {
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
      const refusal = capabilityRefusal(c, 'deployments', null, app);
      if (refusal) return refusal;
      const body = c.req.valid('json');
      if (isDeprecatedProvider(body.provider)) {
        return c.json({ error: DEPRECATED_PROVIDER_ERROR, code: DEPRECATED_PROVIDER_CODE }, 400);
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
      // A static site runs no machine: it has no release config.
      let releaseConfig = null;
      let hostingProvider: string | null = body.provider ?? null;
      if (source.kind !== 'static') {
        const resolved = resolveDeployConfig(body.config, app, 'port' in source ? source.port : undefined);
        if ('issues' in resolved) {
          return c.json({ error: 'The release config is invalid', code: 'app_config_invalid', ...boundedIssues(resolved.issues) }, 400);
        }
        releaseConfig = resolved.config;
        const [latest] = await db.select({ provider: appDeployments.hostingProvider }).from(appDeployments)
          .where(and(eq(appDeployments.appId, appId), isNotNull(appDeployments.hostingProvider)))
          .orderBy(desc(appDeployments.version)).limit(1);
        const choice = chooseReleaseProvider({
          requested: body.provider,
          hasMounts: releaseConfig.mounts.length > 0,
          previous: config.ALLOWED_SANDBOX_PROVIDERS.find((name) => name === latest?.provider),
          platinumEnabled: config.isPlatinumEnabled(),
          platformDefault: config.getDefaultProvider(),
        });
        if (!choice.ok) {
          return c.json({ error: `Volumes need the platinum provider, not ${choice.provider}.`, code: 'app_volumes_unsupported' }, 400);
        }
        hostingProvider = choice.provider;
      }
      const deployment = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId}))`);
        const [versionRow] = await tx.select({ value: max(appDeployments.version) }).from(appDeployments)
          .where(eq(appDeployments.appId, appId));
        const version = Number(versionRow?.value ?? 0) + 1;
        const [row] = await tx.insert(appDeployments).values({
          appId, artifactId: artifact.artifactId, version, status: 'queued',
          sourceKind: source.kind, hostingProvider,
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
          config: releaseConfig,
          strategy: releaseConfig?.deploy.strategy ?? null,
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
      const loaded = await authorizedProject(c, projectId, 'deploy');
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
      const loaded = await authorizedProject(c, projectId, 'deploy');
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
      const loaded = await authorizedProject(c, projectId, 'deploy');
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
        return c.json(await appJson(row!, loaded.userId));
      },
    );
  }

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/rollback', tags: ['apps'], summary: 'Roll back an App', ...auth,
      description:
        'Roll back to an earlier release: a NEW release (the next version) from that release\'s artifact and ' +
        'config, rolled out on its strategy like any deploy. Volumes keep their data. Answers 202 ' +
        'with the App and the queued release in `deployment`.',
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }), body: { content: { 'application/json': { schema: z.object({ deployment_id: z.string().uuid() }) } } } },
      responses: { 202: json(AppObject, 'App'), ...errors(403, 404, 409) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      const loaded = await authorizedProject(c, projectId, 'deploy');
      if (loaded instanceof Response) return loaded;
      const app = await visibleApp(projectId, appId, loaded.userId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      const refusal = capabilityRefusal(c, 'rollback', null, app);
      if (refusal) return refusal;
      const { deployment_id: deploymentId } = c.req.valid('json');
      const [target] = await db.select().from(appDeployments).where(and(
        eq(appDeployments.deploymentId, deploymentId),
        eq(appDeployments.appId, appId),
        eq(appDeployments.status, 'ready'),
      )).limit(1);
      if (!target) return c.json({ error: 'Only a ready release can be rolled back to', code: 'release_not_ready' }, 409);
      if (!target.artifactId) return c.json({ error: 'That release has no artifact to rebuild', code: 'release_not_rebuildable' }, 409);
      const release = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId}))`);
        const [versionRow] = await tx.select({ value: max(appDeployments.version) }).from(appDeployments)
          .where(eq(appDeployments.appId, appId));
        const [row] = await tx.insert(appDeployments).values({
          appId,
          artifactId: target.artifactId,
          version: Number(versionRow?.value ?? 0) + 1,
          status: 'queued',
          sourceKind: target.sourceKind,
          hostingProvider: target.hostingProvider,
          createdBy: loaded.userId,
          sourceSessionId: callerKortixSessionId(c),
          actorType: appDeploymentActorType(c),
          runtimeVersion: APP_RUNTIME_VERSION,
          buildSpec: target.buildSpec,
          runtimeSpec: {},
          config: target.config,
          strategy: target.strategy,
        }).returning();
        await tx.update(apps).set({ desiredState: 'running', updatedAt: new Date() }).where(eq(apps.appId, appId));
        return row!;
      });
      await db.insert(appDeploymentEvents).values({
        deploymentId: release.deploymentId,
        type: 'deployment_rollback',
        message: `Rollback to v${target.version}`,
        data: { rollbackOf: target.deploymentId, rollbackVersion: target.version, previousDeploymentId: app.activeDeploymentId },
      });
      triggerAppDeploymentWorker();
      const [row] = await db.select().from(apps).where(eq(apps.appId, appId)).limit(1);
      return c.json({ ...(await appJson(row!, loaded.userId)), deployment: serializeDeployment(release) }, 202);
    },
  );
}
