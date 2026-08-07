import { randomBytes, randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import {
  appArtifacts,
  appDeploymentEvents,
  appDeployments,
  appRuntimes,
  apps,
} from '@kortix/db';
import { and, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../iam';
import { auth, errors, json } from '../openapi';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { getProvider } from '../platform/providers';
import { db } from '../shared/db';
import { createAppArtifactUploadUrl, MAX_ARCHIVE_BYTES } from './artifacts';
import { APP_RUNTIME_VERSION, triggerAppDeploymentWorker } from './deployment-worker';
import { AppHostingProvider } from './hosting';
import { deploymentEventsAsLogs } from './logs';
import { ensureAppRuntimeRunning, loadPublicApp } from './public-proxy';
import { type AppSourceSpec } from './spec';
import { AppBudgetExceededError } from './budget';
import { assertProjectCapability, loadProjectForUser } from '../projects/lib/access';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { projectsApp } from '../projects/lib/app';
import { resolveExperimentalFeature } from '../experimental/features';
import {
  appAccessibleToUser,
  appAccessSessionUrl,
  persistAppAccessPolicy,
  serializeAppAccessPolicy,
  validateAppAccessPrincipals,
  type AppAccessMode,
} from './access';

const AppObject = z.object({}).passthrough().openapi('KortixApp');
const DeploymentObject = z.object({}).passthrough().openapi('KortixAppDeployment');
const ArtifactObject = z.object({}).passthrough().openapi('KortixAppArtifact');
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APP_ENV_NAME = /^(?!KORTIX_|OPENCODE_)[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const APP_SECRET_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
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

export function appPublicUrl(row: { slug: string; routeKey: string }): string {
  const localPort = process.env.KORTIX_APPS_LOCAL_PORT || String(config.PORT);
  if (process.env.KORTIX_APPS_LOCAL === 'true' || config.KORTIX_URL.includes('localhost')) {
    return `http://${row.routeKey}.apps.localhost:${localPort}`;
  }
  const domain = (process.env.KORTIX_APPS_BASE_DOMAIN || 'apps.kortix.com').replace(/^\.+|\.+$/g, '');
  return `https://${config.INTERNAL_KORTIX_ENV}-${row.slug}-${row.routeKey}.${domain}`;
}

function serializeApp(row: typeof apps.$inferSelect) {
  return {
    app_id: row.appId,
    account_id: row.accountId,
    project_id: row.projectId,
    slug: row.slug,
    name: row.name,
    url: appPublicUrl(row),
    access_mode: row.accessMode as AppAccessMode,
    access_revision: row.accessRevision,
    desired_state: row.desiredState,
    active_deployment_id: row.activeDeploymentId,
    machine: { cpu: row.cpuCores, memory_gb: row.memoryGb, disk_gb: row.diskGb },
    idle_timeout_seconds: row.idleTimeoutSeconds,
    monthly_budget_usd: Number(row.monthlyBudgetUsd),
    last_request_at: row.lastRequestAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
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

async function authorizedProject(c: any, projectId: string, write = false) {
  const loaded = await loadProjectForUser(c, projectId, write ? 'write' : 'read');
  if (!loaded) return null;
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    write ? PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE : PROJECT_ACTIONS.PROJECT_GITOPS_READ,
  );
  if (!resolveExperimentalFeature(loaded.row.metadata, 'apps')) return null;
  return loaded;
}

async function scopedApp(projectId: string, appId: string) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.appId, appId), eq(apps.projectId, projectId), isNull(apps.deletedAt)))
    .limit(1);
  return row ?? null;
}

projectsApp.openapi(
  createRoute({
    method: 'get', path: '/{projectId}/apps', tags: ['apps'], summary: 'List Apps', ...auth,
    request: { params: z.object({ projectId: z.string().uuid() }) },
    responses: { 200: json(z.object({ apps: z.array(AppObject) }), 'Apps'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    if (!(await authorizedProject(c, projectId))) return c.json({ error: 'Not found' }, 404);
    const rows = await db.select().from(apps)
      .where(and(eq(apps.projectId, projectId), isNull(apps.deletedAt)))
      .orderBy(desc(apps.createdAt));
    return c.json({ apps: rows.map(serializeApp) });
  },
);

const AppAccessSchema = z.object({
  mode: z.enum(['private', 'project', 'restricted', 'public', 'password']),
  revision: z.number().int().positive(),
  member_ids: z.array(z.string().uuid()).max(100).default([]),
  group_ids: z.array(z.string().uuid()).max(100).default([]),
  password_configured: z.boolean(),
});

projectsApp.openapi(
  createRoute({
    method: 'get', path: '/{projectId}/apps/{appId}/access', tags: ['apps'], summary: 'Get App access policy', ...auth,
    request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
    responses: { 200: json(AppAccessSchema, 'App access policy'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const { projectId, appId } = c.req.param();
    if (!(await authorizedProject(c, projectId))) return c.json({ error: 'Not found' }, 404);
    const row = await scopedApp(projectId, appId);
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
      }) } } },
    },
    responses: { 200: json(AppAccessSchema, 'App access policy'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const { projectId, appId } = c.req.param();
    const loaded = await authorizedProject(c, projectId, true);
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const current = await scopedApp(projectId, appId);
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
    });
    return c.json(await serializeAppAccessPolicy(row));
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
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const row = await scopedApp(projectId, appId);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (row.accessMode !== 'public' && row.accessMode !== 'password' && !(await appAccessibleToUser(row, loaded.userId))) {
      return c.json({ error: 'App access denied' }, 403);
    }
    if (row.accessMode === 'public' || row.accessMode === 'password') {
      return c.json({ url: appPublicUrl(row), expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
    }
    const session = appAccessSessionUrl(appPublicUrl(row), row, loaded.userId);
    return c.json({ url: session.url, expires_at: session.expiresAt.toISOString() });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post', path: '/{projectId}/apps', tags: ['apps'], summary: 'Create an App', ...auth,
    request: {
      params: z.object({ projectId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: z.object({
        slug: z.string().min(1).max(63), name: z.string().min(1).max(200),
        cpu: z.number().int().min(1).max(64).default(1),
        memory_gb: z.number().int().min(1).max(512).default(2),
        disk_gb: z.number().int().min(1).max(2048).default(10),
        idle_timeout_seconds: z.number().int().min(120).max(86400).default(300),
        monthly_budget_usd: z.number().min(0).max(100000).default(5),
      }) } } },
    },
    responses: { 201: json(AppObject, 'App'), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await authorizedProject(c, projectId, true);
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const body = c.req.valid('json');
    const slug = body.slug.toLowerCase();
    if (!APP_SLUG.test(slug)) return c.json({ error: 'slug must contain lowercase letters, numbers, and single hyphens' }, 400);
    try {
      const [row] = await db.insert(apps).values({
        accountId: loaded.row.accountId, projectId, slug, name: body.name.trim(),
        routeKey: randomBytes(8).toString('hex'), createdBy: loaded.userId,
        cpuCores: body.cpu, memoryGb: body.memory_gb, diskGb: body.disk_gb,
        idleTimeoutSeconds: body.idle_timeout_seconds,
        monthlyBudgetUsd: body.monthly_budget_usd.toFixed(2),
      }).returning();
      return c.json(serializeApp(row!), 201);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return c.json({ error: 'An App with this slug already exists' }, 409);
      throw error;
    }
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
    responses: { 201: json(z.object({ artifact: ArtifactObject, upload: z.object({ url: z.string(), max_bytes: z.number() }).nullable() }), 'Artifact'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await authorizedProject(c, projectId, true);
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const body = c.req.valid('json');
    const artifactId = randomUUID();
    if (body.kind === 'oci_image') {
      const [artifact] = await db.insert(appArtifacts).values({
        artifactId, accountId: loaded.row.accountId, projectId, kind: body.kind,
        status: 'ready', imageReference: body.image, createdBy: loaded.userId,
      }).returning();
      return c.json({ artifact: serializeArtifact(artifact!), upload: null }, 201);
    }
    const upload = await createAppArtifactUploadUrl(loaded.row.accountId, projectId, artifactId);
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
    if (!(await authorizedProject(c, projectId, true))) return c.json({ error: 'Not found' }, 404);
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
    if (!(await authorizedProject(c, projectId))) return c.json({ error: 'Not found' }, 404);
    const row = await scopedApp(projectId, appId);
    return row ? c.json(serializeApp(row)) : c.json({ error: 'Not found' }, 404);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'patch', path: '/{projectId}/apps/{appId}', tags: ['apps'], summary: 'Update an App', ...auth,
    request: {
      params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: z.object({
        name: z.string().min(1).max(200).optional(), cpu: z.number().int().min(1).max(64).optional(),
        memory_gb: z.number().int().min(1).max(512).optional(), disk_gb: z.number().int().min(1).max(2048).optional(),
        idle_timeout_seconds: z.number().int().min(120).max(86400).optional(), monthly_budget_usd: z.number().min(0).max(100000).optional(),
      }) } } },
    },
    responses: { 200: json(AppObject, 'App'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const { projectId, appId } = c.req.param();
    if (!(await authorizedProject(c, projectId, true))) return c.json({ error: 'Not found' }, 404);
    const body = c.req.valid('json');
    const [row] = await db.update(apps).set({
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.cpu !== undefined ? { cpuCores: body.cpu } : {}),
      ...(body.memory_gb !== undefined ? { memoryGb: body.memory_gb } : {}),
      ...(body.disk_gb !== undefined ? { diskGb: body.disk_gb } : {}),
      ...(body.idle_timeout_seconds !== undefined ? { idleTimeoutSeconds: body.idle_timeout_seconds } : {}),
      ...(body.monthly_budget_usd !== undefined ? { monthlyBudgetUsd: body.monthly_budget_usd.toFixed(2) } : {}),
      updatedAt: new Date(),
    }).where(and(eq(apps.appId, appId), eq(apps.projectId, projectId), isNull(apps.deletedAt))).returning();
    return row ? c.json(serializeApp(row)) : c.json({ error: 'Not found' }, 404);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete', path: '/{projectId}/apps/{appId}', tags: ['apps'], summary: 'Delete an App', ...auth,
    request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
    responses: { 200: json(z.object({ ok: z.boolean() }), 'Deleted'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const { projectId, appId } = c.req.param();
    if (!(await authorizedProject(c, projectId, true))) return c.json({ error: 'Not found' }, 404);
    const row = await scopedApp(projectId, appId);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const runtimes = await db.select().from(appRuntimes)
      .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
      .where(eq(appDeployments.appId, appId));
    for (const item of runtimes) {
      const runtime = item.app_runtimes;
      await getProvider(runtime.provider as SandboxProviderName).remove(runtime.externalId).catch(() => {});
      await pauseComputeSession(runtime.runtimeId).catch(() => {});
    }
    await db.update(apps).set({ deletedAt: new Date(), desiredState: 'stopped', activeDeploymentId: null, updatedAt: new Date() })
      .where(eq(apps.appId, appId));
    return c.json({ ok: true });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post', path: '/{projectId}/apps/{appId}/deployments', tags: ['apps'], summary: 'Deploy an App', ...auth,
    request: {
      params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: z.object({
        artifact_id: z.string().uuid(),
        source: SourceSchema,
        provider: z.enum(['daytona', 'platinum', 'e2b']).optional(),
        environment: EnvironmentSchema.optional(),
        secrets: SecretMappingsSchema.optional(),
      }) } } },
    },
    responses: { 202: json(DeploymentObject, 'Deployment queued'), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const { projectId, appId } = c.req.param();
    const loaded = await authorizedProject(c, projectId, true);
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const app = await scopedApp(projectId, appId);
    if (!app) return c.json({ error: 'Not found' }, 404);
    const body = c.req.valid('json');
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
    if (!(await authorizedProject(c, projectId))) return c.json({ error: 'Not found' }, 404);
    if (!(await scopedApp(projectId, appId))) return c.json({ error: 'Not found' }, 404);
    const rows = await db.select().from(appDeployments).where(eq(appDeployments.appId, appId)).orderBy(desc(appDeployments.version));
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
    if (!(await authorizedProject(c, projectId))) return c.json({ error: 'Not found' }, 404);
    if (!(await scopedApp(projectId, appId))) return c.json({ error: 'Not found' }, 404);
    const [deployment] = await db.select().from(appDeployments).where(and(eq(appDeployments.deploymentId, deploymentId), eq(appDeployments.appId, appId))).limit(1);
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
    if (!(await authorizedProject(c, projectId))) return c.json({ error: 'Not found' }, 404);
    if (!(await scopedApp(projectId, appId))) return c.json({ error: 'Not found' }, 404);
    const [deployment] = await db.select().from(appDeployments).where(and(
      eq(appDeployments.deploymentId, deploymentId),
      eq(appDeployments.appId, appId),
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

for (const action of ['start', 'stop'] as const) {
  projectsApp.openapi(
    createRoute({
      method: 'post', path: `/{projectId}/apps/{appId}/${action}`, tags: ['apps'], summary: `${action} an App`, ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }) },
      responses: { 200: json(AppObject, 'App'), ...errors(402, 403, 404, 409, 503) },
    }),
    async (c: any) => {
      const { projectId, appId } = c.req.param();
      if (!(await authorizedProject(c, projectId, true))) return c.json({ error: 'Not found' }, 404);
      const app = await scopedApp(projectId, appId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      if (!app.activeDeploymentId) return c.json({ error: 'App has no active deployment' }, 409);
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
          if (error instanceof AppBudgetExceededError) {
            return c.json({
              error: error.message,
              code: 'app_budget_exceeded',
              spent_usd: error.spentUsd,
              budget_usd: error.budgetUsd,
            }, 402);
          }
          return c.json({
            error: 'App start failed',
            detail: error instanceof Error ? error.message : String(error),
          }, 503);
        }
      }
      return c.json(serializeApp(row!));
    },
  );
}

projectsApp.openapi(
  createRoute({
    method: 'post', path: '/{projectId}/apps/{appId}/rollback', tags: ['apps'], summary: 'Roll back an App', ...auth,
    request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }), body: { content: { 'application/json': { schema: z.object({ deployment_id: z.string().uuid() }) } } } },
    responses: { 200: json(AppObject, 'App'), ...errors(402, 403, 404, 409, 503) },
  }),
  async (c: any) => {
    const { projectId, appId } = c.req.param();
    if (!(await authorizedProject(c, projectId, true))) return c.json({ error: 'Not found' }, 404);
    const app = await scopedApp(projectId, appId);
    if (!app) return c.json({ error: 'Not found' }, 404);
    const { deployment_id: deploymentId } = c.req.valid('json');
    const [deployment] = await db.select().from(appDeployments).where(and(eq(appDeployments.deploymentId, deploymentId), eq(appDeployments.appId, appId), eq(appDeployments.status, 'ready'))).limit(1);
    if (!deployment) return c.json({ error: 'Only a ready deployment can receive rollback traffic' }, 409);
    const [targetRuntime] = await db.select().from(appRuntimes)
      .where(eq(appRuntimes.deploymentId, deploymentId))
      .orderBy(desc(appRuntimes.createdAt))
      .limit(1);
    if (!targetRuntime) return c.json({ error: 'Rollback deployment has no runtime' }, 409);

    const [runningApp] = await db.update(apps)
      .set({ desiredState: 'running', updatedAt: new Date() })
      .where(eq(apps.appId, appId))
      .returning();
    const hosting = new AppHostingProvider();
    try {
      await ensureAppRuntimeRunning({ app: runningApp!, deployment, runtime: targetRuntime }, hosting);
    } catch (error) {
      await db.update(apps).set({ desiredState: app.desiredState, updatedAt: new Date() })
        .where(eq(apps.appId, appId));
      if (error instanceof Response) return c.json(await error.json(), error.status as 402 | 409 | 503);
      if (error instanceof AppBudgetExceededError) {
        return c.json({
          error: error.message,
          code: 'app_budget_exceeded',
          spent_usd: error.spentUsd,
          budget_usd: error.budgetUsd,
        }, 402);
      }
      return c.json({
        error: 'Rollback runtime failed to start',
        detail: error instanceof Error ? error.message : String(error),
      }, 503);
    }

    const previousDeploymentId = app.activeDeploymentId;
    const [row] = await db.update(apps)
      .set({ activeDeploymentId: deploymentId, desiredState: 'running', updatedAt: new Date() })
      .where(eq(apps.appId, appId))
      .returning();
    await db.insert(appDeploymentEvents).values({
      deploymentId,
      runtimeId: targetRuntime.runtimeId,
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
    return c.json(serializeApp(row!));
  },
);
