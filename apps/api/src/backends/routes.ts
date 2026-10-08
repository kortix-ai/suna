import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../iam';
import { auth, errors, json } from '../openapi';
import { recordAuditEvent } from '../shared/audit';
import { inspectDatabaseError } from '../shared/database-errors';
import { logger } from '../lib/logger';
import { assertProjectCapability, loadProjectForUser, projectsApp } from '../projects/surface';
import { requireFeatureFlag } from '../feature-flags/gate';
import { resolveSessionSandboxRegion } from '../platform/services/sandbox-region';
import type { AppEnv } from '../types';
import { resolveAppViewerIdentity } from '../apps/viewer';
import { actorOf } from '../middleware/actor';
import { checkBillingAdmission } from '../billing/services/billing-gate';
import {
  BackendLimitError,
  type BackendRow,
  backendAdminKey,
  backendMemberToken,
  backendPublicAuthEnv,
  effectiveStatus,
  getLiveBackend,
  insertBackend,
  listProjectBackends,
  provisionBackend,
} from './provision';
import { backendDashboardUrl, backendPublicUrls } from './hosts';
import { BACKEND_TOKEN_TTL_SECONDS } from './auth';
import { CONVEX_CLI_VERSION } from './convex-image';
import {
  BACKEND_OPERATIONS,
  BackendOperationError,
  MAX_LOG_LINES,
  backendOperation,
  backendProviderFailure,
  beginResize,
  AUTOMATIC_SNAPSHOT_RETENTION_MS,
  MAX_MANUAL_SNAPSHOTS,
  RESIZE_SNAPSHOT_RETENTION_MS,
  SNAPSHOT_KINDS,
  createBackendSnapshot,
  deleteBackendExclusive,
  deleteBackendSnapshot,
  listBackendBackups,
  readBackendLog,
  restoreBackendSnapshot,
  rotateBackendAdminKey,
  runResize,
} from './operations';
import type { BackendHealth } from './maintenance';

const STATUSES = ['provisioning', 'running', 'error', 'deleted'] as const;

const BackendHealthObject = z
  .object({
    ok: z.boolean(),
    checked_at: z.string(),
    machine_state: z.string().nullable().openapi({
      description: "The machine's state: `running`, `stopped`, `restoring`, …; `missing` when it no longer exists.",
    }),
    failures: z.number().int().openapi({ description: 'Failed probes in a row.' }),
    error: z.string().nullable(),
    disk_used_pct: z.number().nullable(),
    repair: z.enum(['started', 'restored_from_backup']).nullable().openapi({
      description: 'What the probe started to bring the machine back, if anything.',
    }),
  })
  .openapi('BackendHealth');

const BackendObject = z
  .object({
    backend_id: z.string().uuid(),
    project_id: z.string().uuid(),
    name: z.string(),
    status: z.enum(STATUSES),
    url: z.string().nullable().openapi({
      description: 'Convex client URL (CONVEX_URL): the backend\'s Kortix host, fixed for the backend\'s life.',
    }),
    site_url: z.string().nullable().openapi({ description: 'Convex HTTP actions URL: a second Kortix host, fixed for the backend\'s life.' }),
    dashboard_url: z.string().nullable().openapi({
      description: "Convex's dashboard for this backend. Kortix web frames it and signs it in; null on older machines.",
    }),
    cpu: z.number().int(),
    memory_gb: z.number().int(),
    disk_gb: z.number().int(),
    error: z.string().nullable(),
    operation: z.enum(BACKEND_OPERATIONS).nullable().openapi({
      description:
        'A day-two operation in flight: `resizing`, `rotating_key` (admin-key rotation), `recovering` (Kortix ' +
        'is starting the machine or restoring it from its last automatic backup), `snapshotting` (a snapshot is ' +
        'taken or deleted; the machine pauses for the copy), `restoring` (a snapshot restore).',
    }),
    last_operation_error: z.string().nullable(),
    health: BackendHealthObject.nullable().openapi({
      description: 'The last health probe (every 5 min while the backend runs). null until the first probe.',
    }),
    auth_env: z
      .object({ KORTIX_AUTH_ISSUER: z.string(), KORTIX_AUTH_AUDIENCE: z.string(), KORTIX_AUTH_JWKS: z.string() })
      .nullable()
      .openapi({
        description:
          'Public values that verify this backend\'s member tokens (no secret). Set them on any server that calls ' +
          '`verifyKortixMemberToken`. `KORTIX_AUTH_ISSUER` is a public URL: `<issuer>/jwks.json` serves the key set ' +
          'and `<issuer>/.well-known/openid-configuration` names it. null for a backend created before Kortix sign-in.',
      }),
    convex_version: z.string().openapi({
      description: 'The `convex` npm CLI version that matches this backend. Deploy with `npx convex@<version> deploy`.',
    }),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Backend');

const SizeFields = {
  cpu: z.number().int().min(1).max(16).optional(),
  memory_gb: z.number().int().min(1).max(32).optional(),
  disk_gb: z.number().int().min(10).max(100).optional(),
};

const BackendSnapshot = z
  .object({
    snapshot_id: z.string(),
    created_at: z.string(),
    size_bytes: z.number().nullable(),
    kind: z.enum(SNAPSHOT_KINDS).openapi({
      description:
        '`manual`: taken by a member or agent, kept until deleted. `automatic`: the daily snapshot, kept ' +
        `${AUTOMATIC_SNAPSHOT_RETENTION_MS / 86_400_000} days. \`resize\`: taken before a resize, kept ${RESIZE_SNAPSHOT_RETENTION_MS / 3_600_000} hours ` +
        'or until the next resize replaces it (a backend holds at most one).',
    }),
    expires_at: z.string().nullable().openapi({
      description:
        'When Kortix deletes this snapshot; null for a manual one. The newest automatic snapshot stays past ' +
        'its expiry until a newer one exists. Deletion runs in the 5-minute maintenance pass while the backend runs.',
    }),
  })
  .openapi('BackendSnapshot');

const BackendBackups = z
  .object({
    automatic: z.object({
      state: z.string().nullable(),
      last_backup_at: z.string().nullable(),
      size_bytes: z.number().nullable(),
      interval_minutes: z.number().nullable(),
    }),
    snapshots: z.array(BackendSnapshot).openapi({ description: 'Newest first.' }),
    snapshot_limit: z.number().int().openapi({
      description: `How many manual snapshots the backend holds (${MAX_MANUAL_SNAPSHOTS}). At the limit a new one answers 409 \`snapshot_limit\`; nothing is dropped.`,
    }),
    snapshot_schedule: z
      .object({
        automatic_interval_hours: z.number().int(),
        automatic_retention_days: z.number().int(),
        resize_retention_hours: z.number().int(),
        last_automatic_at: z.string().nullable().openapi({ description: 'When the last automatic snapshot was taken; null before the first.' }),
      })
      .openapi({ description: 'When Kortix takes and deletes snapshots on its own.' }),
  })
  .openapi('BackendBackups');

const BackendCredentials = z
  .object({
    url: z.string(),
    site_url: z.string(),
    admin_key: z.string(),
    env: z.record(z.string(), z.string()).openapi({
      description: 'Ready-to-use variables for the Convex CLI against this backend.',
    }),
  })
  .openapi('BackendCredentials');

const BackendToken = z
  .object({
    token: z.string().openapi({ description: 'ES256 JWT the backend accepts as `ctx.auth`. Send it with `client.setAuth`.' }),
    expires_at: z.string(),
  })
  .openapi('BackendToken');

const NameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes, starting with a letter');

const ProjectParams = z.object({ projectId: z.string().uuid() });
const BackendParams = z.object({ projectId: z.string().uuid(), backendId: z.string().uuid() });
const SnapshotParams = BackendParams.extend({ snapshotId: z.string().min(1).max(128) });

function serialize(row: BackendRow) {
  const status = effectiveStatus(row) as (typeof STATUSES)[number];
  const lastError =
    status !== row.status
      ? 'Provisioning was interrupted. Delete this backend and create it again.'
      : (row.metadata as { lastError?: unknown }).lastError;
  return {
    backend_id: row.backendId,
    project_id: row.projectId,
    name: row.name,
    status,
    // The Kortix hosts, also for a row maintenance has not moved off its Platinum URLs yet.
    url: row.url ? backendPublicUrls(row.backendId).url : null,
    site_url: row.siteUrl ? backendPublicUrls(row.backendId).siteUrl : null,
    dashboard_url: backendDashboardUrl(row),
    cpu: row.cpu,
    memory_gb: row.memoryGb,
    disk_gb: row.diskGb,
    error: status === 'error' && typeof lastError === 'string' ? lastError : null,
    operation: backendOperation(row),
    last_operation_error: ((row.metadata as { lastOperationError?: unknown }).lastOperationError as string | undefined) ?? null,
    health: ((row.metadata as { health?: BackendHealth }).health ?? null),
    auth_env: backendPublicAuthEnv(row),
    convex_version: CONVEX_CLI_VERSION,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Membership, then capability, then the `backends` flag — the Apps order
 * (apps/routes.ts). Returns the loaded project, or the Response to answer.
 */
async function authorizedProject(c: Context<AppEnv>, projectId: string, write = false) {
  const loaded = await loadProjectForUser(c, projectId, write ? 'write' : 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    write ? PROJECT_ACTIONS.PROJECT_BACKEND_WRITE : PROJECT_ACTIONS.PROJECT_BACKEND_READ,
  );
  return requireFeatureFlag(c, loaded.row.metadata, 'backends') ?? loaded;
}

/**
 * The wallet gate session create runs. A backend bills its reserved size from
 * its first second, so an account that cannot pay creates or grows none. The
 * 402 body is the one every billing gate answers (BillingGateError).
 */
async function unfundedBody(accountId: string) {
  const gate = await checkBillingAdmission(accountId);
  if (gate.ok) return null;
  return {
    error: gate.message,
    code: gate.reason,
    balance: gate.balance,
    billing_model: gate.billingModel,
    has_subscription: gate.hasSubscription,
    billing_state: gate.billingState,
    account_id: accountId,
  };
}

export function registerBackendsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/backends', tags: ['backends'], summary: 'List backends', ...auth,
      request: { params: ProjectParams },
      responses: { 200: json(z.object({ backends: z.array(BackendObject) }), 'Backends'), ...errors(403, 404) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const rows = await listProjectBackends(projectId);
      return c.json({ backends: rows.map(serialize) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/backends', tags: ['backends'], summary: 'Create a backend', ...auth,
      description:
        'Claims the name and starts provisioning a self-hosted Convex backend in its own machine. ' +
        'Answers 202 with status `provisioning`; poll the backend until it is `running` or `error`. ' +
        'Usually a few seconds; the first create in a region also builds the image.',
      request: {
        params: ProjectParams,
        body: { content: { 'application/json': { schema: z.object({ name: NameSchema, ...SizeFields }) } }, required: true },
      },
      responses: {
        202: json(z.object({ backend: BackendObject }), 'Provisioning'),
        ...errors(400, 402, 403, 404, 409),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const { name, cpu, memory_gb: memoryGb, disk_gb: diskGb } = c.req.valid('json');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const unfunded = await unfundedBody(loaded.row.accountId);
      if (unfunded) return c.json(unfunded, 402);
      let row: BackendRow;
      try {
        row = await insertBackend({
          projectId,
          accountId: loaded.row.accountId,
          userId: loaded.userId,
          name,
          size: { cpu, memoryGb, diskGb },
        });
      } catch (error) {
        if (error instanceof BackendLimitError) {
          return c.json({ error: error.message, code: 'backend_limit' }, 409);
        }
        if (inspectDatabaseError(error)?.pgCode === '23505') {
          return c.json({ error: `a backend named "${name}" already exists`, code: 'backend_name_taken' }, 409);
        }
        throw error;
      }
      // Outlives the response; a failure lands on the row as status `error`.
      // It heartbeats: if this process dies, maintenance resumes it.
      void provisionBackend(row, resolveSessionSandboxRegion(loaded.row.metadata)).catch((error) =>
        logger.error('[backends] provision failed', { projectId, backendId: row.backendId, error: String(error) }),
      );
      return c.json({ backend: serialize(row) }, 202);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/backends/{backendId}', tags: ['backends'], summary: 'Get a backend', ...auth,
      request: { params: BackendParams },
      responses: { 200: json(z.object({ backend: BackendObject }), 'Backend'), ...errors(403, 404) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      return c.json({ backend: serialize(row) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/backends/{backendId}/credentials', tags: ['backends'],
      summary: 'Get backend admin credentials', ...auth,
      description: 'The admin key controls the backend\'s code and data. Every read is audited.',
      request: { params: BackendParams },
      responses: { 200: json(BackendCredentials, 'Credentials'), ...errors(403, 404, 409) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const { adminKeyEnc } = row;
      if (row.status !== 'running' || !row.url || !row.siteUrl || !adminKeyEnc) {
        return c.json({ error: `backend is ${effectiveStatus(row)}`, code: 'backend_not_running' }, 409);
      }
      const adminKey = backendAdminKey({ ...row, adminKeyEnc });
      const { url, siteUrl } = backendPublicUrls(row.backendId);
      // The admin key controls the backend: no cache (browser, proxy, CDN) may keep it.
      c.header('Cache-Control', 'no-store');
      await recordAuditEvent({
        accountId: loaded.row.accountId,
        projectId,
        actorUserId: loaded.userId,
        action: 'backend.credentials.read',
        resourceType: 'project_backend',
        resourceId: row.backendId,
        metadata: { name: row.name },
      });
      return c.json(
        {
          url,
          site_url: siteUrl,
          admin_key: adminKey,
          env: { CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey },
        },
        200,
      );
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/backends/{backendId}/token', tags: ['backends'],
      summary: 'Mint a Kortix sign-in token for the backend', ...auth,
      description:
        `A ${BACKEND_TOKEN_TTL_SECONDS / 60}-minute JWT naming the caller (\`subject\` = Kortix user id, \`email\`). The backend verifies it ` +
        'with the key Kortix wrote into its environment; read it in a function with `ctx.auth.getUserIdentity()`. ' +
        'An agent session gets a token naming its agent (`subject` = service account id, `kind: "agent"`, no role, no groups), ' +
        'never the human who launched it.',
      request: { params: BackendParams },
      responses: { 200: json(BackendToken, 'Token'), ...errors(403, 404, 409) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      if (row.status !== 'running') {
        return c.json({ error: `backend is ${effectiveStatus(row)}`, code: 'backend_not_running' }, 409);
      }
      // An agent session's credential names the human who launched it. A token
      // for that id would carry the human's role and groups, so the agent gets
      // one naming its own service account, with no role and no groups.
      const { credential } = await actorOf(c, row.accountId);
      const minted = backendMemberToken(
        row,
        credential.kind === 'agent_session'
          ? { userId: credential.serviceAccountId, email: null, kind: 'agent' }
          : { userId: loaded.userId, ...(await resolveAppViewerIdentity(loaded.userId, row.accountId)) },
      );
      if (!minted) {
        return c.json({ error: 'this backend predates Kortix sign-in; create a new backend', code: 'backend_auth_unavailable' }, 409);
      }
      c.header('Cache-Control', 'no-store');
      return c.json({ token: minted.token, expires_at: minted.expiresAt.toISOString() }, 200);
    },
  );

  // A provider failure answers a short mapped reason; its raw text (route,
  // machine id, body) goes to the log only. Anything else rethrows (500).
  const operationError = (c: Context<AppEnv>, error: unknown) => {
    const known = error instanceof BackendOperationError ? error : backendProviderFailure(error);
    if (!known) return null;
    if (!(error instanceof BackendOperationError)) {
      logger.warn('[backends] provider call failed', { path: c.req.path, code: known.code, error: String(error) });
    }
    return c.json({ error: known.message, code: known.code }, known.status);
  };

  projectsApp.openapi(
    createRoute({
      method: 'patch', path: '/{projectId}/backends/{backendId}', tags: ['backends'],
      summary: 'Resize a backend', ...auth,
      description:
        'Takes a safety snapshot, stops the machine, resizes it and waits until the backend answers again ' +
        '(seconds of downtime). Answers 202 with `operation: "resizing"`; poll the backend until it clears. ' +
        'Disk only grows.',
      request: {
        params: BackendParams,
        body: { content: { 'application/json': { schema: z.object(SizeFields) } }, required: true },
      },
      responses: { 202: json(z.object({ backend: BackendObject }), 'Resizing'), ...errors(400, 402, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const body = c.req.valid('json');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      // Only a resize that costs more needs the wallet; shrinking is always allowed.
      const grows =
        (body.cpu ?? row.cpu) > row.cpu || (body.memory_gb ?? row.memoryGb) > row.memoryGb || (body.disk_gb ?? row.diskGb) > row.diskGb;
      const unfunded = grows ? await unfundedBody(row.accountId) : null;
      if (unfunded) return c.json(unfunded, 402);
      try {
        const next = await beginResize(row, { cpu: body.cpu, memoryGb: body.memory_gb, diskGb: body.disk_gb });
        // Outlives the response; the result lands on the row. It heartbeats:
        // if this process dies, maintenance recovers the backend.
        void runResize(row, next);
      } catch (error) {
        const answer = operationError(c, error);
        if (answer) return answer;
        throw error;
      }
      const fresh = (await getLiveBackend(projectId, backendId))!;
      return c.json({ backend: serialize(fresh) }, 202);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/backends/{backendId}/rotate-admin-key', tags: ['backends'],
      summary: 'Rotate the admin key', ...auth,
      description:
        'Replaces the admin key. Every key read before stops working (401). Convex derives admin keys from its ' +
        'instance secret, so the secret changes and Convex restarts (about 1 s of downtime; clients reconnect). ' +
        'Documents, files and environment variables stay. Upload URLs not yet used and open pagination cursors ' +
        'stop working. Read the new key from `/credentials`. A restore (snapshot or automatic backup) of a backend ' +
        'whose key was ever rotated rotates it again, so a rotated-away key never works again: read the key again after a restore.',
      request: { params: BackendParams },
      responses: { 200: json(z.object({ backend: BackendObject }), 'Rotated'), ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        await rotateBackendAdminKey(row);
      } catch (error) {
        const answer = operationError(c, error);
        if (answer) return answer;
        throw error;
      }
      return c.json({ backend: serialize((await getLiveBackend(projectId, backendId)) ?? row) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/backends/{backendId}/logs', tags: ['backends'],
      summary: 'Read the Convex process log', ...auth,
      description:
        "The last lines of the Convex backend process log: startup, crashes, restarts, request lines. Function " +
        "logs (console.log in your functions) are in the dashboard's Logs page and in `npx convex logs`.",
      request: {
        params: BackendParams,
        query: z.object({
          lines: z.coerce.number().int().min(1).max(MAX_LOG_LINES).default(200).openapi({
            description: `How many lines, newest last. 1 to ${MAX_LOG_LINES}, default 200.`,
          }),
        }),
      },
      responses: {
        200: json(z.object({ log: z.string() }), 'Log'),
        ...errors(400, 403, 404, 409, 502, 503),
      },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const { lines } = c.req.valid('query');
      // Request lines and errors can carry data: the same permission as the admin key.
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        const log = await readBackendLog(row, lines);
        c.header('Cache-Control', 'no-store');
        return c.json({ log }, 200);
      } catch (error) {
        const answer = operationError(c, error);
        if (answer) return answer;
        throw error;
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/backends/{backendId}/backups', tags: ['backends'],
      summary: 'List backups and snapshots', ...auth,
      description:
        '`automatic`: Kortix copies the backend machine to object storage on a schedule, for recovery from a ' +
        'host loss (Kortix restores it on its own; data since the last copy is lost). `snapshots`: point-in-time ' +
        'copies you can restore, newest first, each with its `kind` and `expires_at`.',
      request: { params: BackendParams },
      responses: { 200: json(BackendBackups, 'Backups'), ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        return c.json(await listBackendBackups(row), 200);
      } catch (error) {
        const answer = operationError(c, error);
        if (answer) return answer;
        throw error;
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/backends/{backendId}/snapshots', tags: ['backends'],
      summary: 'Take a snapshot', ...auth,
      description:
        'A manual point-in-time copy of the running backend (data, files, functions), kept until deleted. ' +
        `A backend holds ${MAX_MANUAL_SNAPSHOTS} manual snapshots; the next answers 409 \`snapshot_limit\`. The machine pauses ` +
        'for the copy (seconds; 8 GB of memory takes up to 90 s). 409 `backend_busy` while another operation runs.',
      request: { params: BackendParams },
      responses: {
        201: json(BackendSnapshot, 'Snapshot'),
        ...errors(400, 403, 404, 409, 502, 503),
      },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        return c.json(await createBackendSnapshot(row), 201);
      } catch (error) {
        const answer = operationError(c, error);
        if (answer) return answer;
        throw error;
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/backends/{backendId}/restore', tags: ['backends'],
      summary: 'Restore a snapshot', ...auth,
      description:
        'Rolls the backend back to one of its snapshots: every change after it is lost. Answers when the machine ' +
        'runs the snapshot and Convex answers (seconds), so a write after the answer is never undone by the restore. ' +
        'A snapshot taken before an applied resize holds the old machine size: 409 `snapshot_predates_resize`. ' +
        '409 `backend_busy` while another operation runs. Read the admin key again afterwards when it was ever rotated.',
      request: {
        params: BackendParams,
        body: { content: { 'application/json': { schema: z.object({ snapshot_id: z.string().min(1) }) } }, required: true },
      },
      responses: { 200: json(z.object({ backend: BackendObject }), 'Restored'), ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const { snapshot_id: snapshotId } = c.req.valid('json');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        await restoreBackendSnapshot(row, snapshotId);
      } catch (error) {
        const answer = operationError(c, error);
        if (answer) return answer;
        throw error;
      }
      return c.json({ backend: serialize((await getLiveBackend(projectId, backendId)) ?? row) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/backends/{backendId}/snapshots/{snapshotId}', tags: ['backends'],
      summary: 'Delete a snapshot', ...auth,
      description:
        'Deletes one snapshot of any kind and frees its storage. This cannot be undone. 404 `snapshot_not_found` ' +
        'when the backend has no such snapshot; 409 `backend_busy` while another operation runs.',
      request: { params: SnapshotParams },
      responses: { 204: { description: 'Deleted' }, ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const { projectId, backendId, snapshotId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        await deleteBackendSnapshot(row, snapshotId);
      } catch (error) {
        const answer = operationError(c, error);
        if (answer) return answer;
        throw error;
      }
      return c.body(null, 204);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/backends/{backendId}', tags: ['backends'],
      summary: 'Delete a backend', ...auth,
      description:
        'Deletes the machine, its snapshots and every document and file in it. This cannot be undone. ' +
        '409 `backend_busy` during a resize, restore, snapshot or key rotation; allowed during `recovering`, ' +
        'so a broken backend can always be deleted. While the delete runs, no new operation starts.',
      request: { params: BackendParams },
      responses: { 204: { description: 'Deleted' }, ...errors(403, 404, 409, 502) },
    }),
    async (c) => {
      const { projectId, backendId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, true);
      if (loaded instanceof Response) return loaded;
      const row = await getLiveBackend(projectId, backendId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        // Claims the backend atomically: no snapshot or other operation starts while the delete runs.
        if (!(await deleteBackendExclusive(row))) {
          const busy = backendOperation(row) ?? 'running another operation';
          return c.json({ error: `the backend is ${busy}; delete it when that finishes`, code: 'backend_busy' }, 409);
        }
      } catch (error) {
        logger.error('[backends] delete failed', { projectId, backendId, error: String(error) });
        return c.json({ error: 'The backend machine could not be deleted. Try again.', code: 'backend_delete_failed' }, 502);
      }
      return c.body(null, 204);
    },
  );
}
