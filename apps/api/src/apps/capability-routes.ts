/**
 * The App routes that exist only for some kinds, each gated by one
 * capability (./kinds): snapshots, restore, admin credentials, member tokens,
 * the process log. An App without the capability answers 409
 * `app_capability_unsupported`. Today `convex` Apps implement all of them
 * (./kinds/convex); a future kind implements the ones it lists.
 *
 *   GET    /projects/:projectId/apps/:appId/snapshots               snapshots   read
 *   POST   /projects/:projectId/apps/:appId/snapshots               snapshots   write
 *   DELETE /projects/:projectId/apps/:appId/snapshots/:snapshotId   snapshots   write
 *   POST   /projects/:projectId/apps/:appId/restore                 restore     admin
 *   GET    /projects/:projectId/apps/:appId/credentials             admin_credentials  admin (audited)
 *   POST   /projects/:projectId/apps/:appId/rotate-credentials      admin_credentials  admin
 *   POST   /projects/:projectId/apps/:appId/token                   member_tokens      read (every kind)
 *   GET    /projects/:projectId/apps/:appId/logs                    logs        write
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../openapi';
import { recordAuditEvent } from '../shared/audit';
import { logger } from '../lib/logger';
import { actorOf } from '../middleware/actor';
import { projectsApp } from '../projects/surface';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { resolveAppViewerIdentity } from './viewer';
import { appJson } from './serialize';

/** The App after the operation (a `KortixApp`). */
const AppResult = z
  .object({ app_id: z.string().uuid(), kind: z.string(), capabilities: z.array(z.string()) })
  .openapi({ description: 'The App after the operation, every `KortixApp` field.' });
import type { AppCapability } from './kinds';
import { type AppPermission, authorizedProject, capabilityRefusal, visibleApp } from './route-access';
import { TOKEN_TTL_SECONDS, mintAppToken } from './tokens';
import { backendPublicUrls } from './kinds/convex/hosts';
import {
  AUTOMATIC_SNAPSHOT_RETENTION_MS,
  BackendOperationError,
  DELETE_RETENTION_MS,
  MAX_LOG_LINES,
  MAX_MANUAL_SNAPSHOTS,
  RESIZE_SNAPSHOT_RETENTION_MS,
  SNAPSHOT_KINDS,
  backendProviderFailure,
  createBackendSnapshot,
  deleteBackendSnapshot,
  listBackendBackups,
  readBackendLog,
  restoreBackendSnapshot,
  rotateBackendAdminKey,
} from './kinds/convex/operations';
import { type ConvexRow, backendAdminKey, effectiveStatus, getLiveConvexApp } from './kinds/convex/provision';

const AppParams = z.object({ projectId: z.string().uuid(), appId: z.string().uuid() });
const SnapshotParams = AppParams.extend({ snapshotId: z.string().min(1).max(128) });

const Snapshot = z
  .object({
    snapshot_id: z.string(),
    created_at: z.string(),
    size_bytes: z.number().nullable(),
    kind: z.enum(SNAPSHOT_KINDS).openapi({
      description:
        '`manual`: taken by a member or agent, kept until deleted. `automatic`: the daily snapshot, kept ' +
        `${AUTOMATIC_SNAPSHOT_RETENTION_MS / 86_400_000} days. \`resize\`: taken before a resize, kept ${RESIZE_SNAPSHOT_RETENTION_MS / 3_600_000} hours ` +
        `or until the next resize replaces it. \`final\`: taken when the App is deleted, kept ${DELETE_RETENTION_MS / 86_400_000} days.`,
    }),
    expires_at: z.string().nullable().openapi({
      description:
        'When Kortix deletes this snapshot; null for a manual one. The newest automatic snapshot stays past ' +
        'its expiry until a newer one exists.',
    }),
  })
  .openapi('KortixAppSnapshot');

const Snapshots = z
  .object({
    automatic: z.object({
      state: z.string().nullable(),
      last_backup_at: z.string().nullable(),
      size_bytes: z.number().nullable(),
      interval_minutes: z.number().nullable(),
    }).openapi({ description: 'The machine-level backup Kortix restores from on a host loss (not selectable).' }),
    snapshots: z.array(Snapshot).openapi({ description: 'Newest first.' }),
    snapshot_limit: z.number().int().openapi({
      description: `Manual snapshots an App holds (${MAX_MANUAL_SNAPSHOTS}). At the limit a new one answers 409 \`snapshot_limit\`.`,
    }),
    snapshot_schedule: z.object({
      automatic_interval_hours: z.number().int(),
      automatic_retention_days: z.number().int(),
      resize_retention_hours: z.number().int(),
      last_automatic_at: z.string().nullable(),
    }),
  })
  .openapi('KortixAppSnapshots');

const Credentials = z
  .object({
    url: z.string(),
    site_url: z.string(),
    admin_key: z.string(),
    env: z.record(z.string(), z.string()).openapi({ description: 'Ready-to-use variables for the client CLI against this App.' }),
  })
  .openapi('KortixAppCredentials');

const MemberToken = z
  .object({
    token: z.string().openapi({ description: 'ES256 JWT the App accepts as the signed-in member.' }),
    expires_at: z.string(),
  })
  .openapi('KortixAppMemberToken');


/** A provider failure answers a short mapped reason; its raw text goes to the log only. Anything else rethrows (500). */
function operationError(c: Context<AppEnv>, error: unknown) {
  const known = error instanceof BackendOperationError ? error : backendProviderFailure(error);
  if (!known) throw error;
  if (!(error instanceof BackendOperationError)) {
    logger.warn('[apps] provider call failed', { path: c.req.path, code: known.code, error: String(error) });
  }
  return c.json({ error: known.message, code: known.code }, known.status);
}

/**
 * Gate, App, capability, machine row, in that order. Returns what the
 * handler needs, or the Response to answer.
 */
async function capableApp(c: Context<AppEnv>, permission: AppPermission, capability: AppCapability) {
  const projectId = c.req.param('projectId')!;
  const appId = c.req.param('appId')!;
  const loaded = await authorizedProject(c, projectId, permission);
  if (loaded instanceof Response) return loaded;
  const app = await visibleApp(projectId, appId, loaded.userId);
  if (!app) return c.json({ error: 'Not found' }, 404);
  const refusal = capabilityRefusal(c, app, capability);
  if (refusal) return refusal;
  const row = await getLiveConvexApp(projectId, appId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  return { loaded, app, row };
}

const notRunning = (c: Context<AppEnv>, row: ConvexRow) =>
  c.json({ error: `the App is ${effectiveStatus(row)}`, code: 'app_not_running' }, 409);

export function registerAppCapabilityRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/snapshots', tags: ['apps'], summary: 'List App snapshots', ...auth,
      description:
        'Capability `snapshots`. `snapshots`: point-in-time copies you can restore, newest first, each with its `kind` ' +
        'and `expires_at`. `automatic`: the machine backup Kortix restores on its own after a host loss.',
      request: { params: AppParams },
      responses: { 200: json(Snapshots, 'Snapshots'), ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const found = await capableApp(c, 'read', 'snapshots');
      if (found instanceof Response) return found;
      try {
        return c.json(await listBackendBackups(found.row), 200);
      } catch (error) {
        return operationError(c, error);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/snapshots', tags: ['apps'], summary: 'Take an App snapshot', ...auth,
      description:
        `Capability \`snapshots\`. A manual copy of the running App, kept until deleted. An App holds ${MAX_MANUAL_SNAPSHOTS} ` +
        'manual snapshots; the next answers 409 `snapshot_limit`. The machine pauses for the copy (seconds). ' +
        '409 `app_busy` while another operation runs.',
      request: { params: AppParams },
      responses: { 201: json(Snapshot, 'Snapshot'), ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const found = await capableApp(c, 'write', 'snapshots');
      if (found instanceof Response) return found;
      try {
        return c.json(await createBackendSnapshot(found.row), 201);
      } catch (error) {
        return operationError(c, error);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/apps/{appId}/snapshots/{snapshotId}', tags: ['apps'], summary: 'Delete an App snapshot', ...auth,
      description:
        'Capability `snapshots`. Deletes one snapshot of any kind. This cannot be undone. 404 `snapshot_not_found` ' +
        'when the App has no such snapshot; 409 `app_busy` while another operation runs.',
      request: { params: SnapshotParams },
      responses: { 204: { description: 'Deleted' }, ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const found = await capableApp(c, 'write', 'snapshots');
      if (found instanceof Response) return found;
      try {
        await deleteBackendSnapshot(found.row, c.req.param('snapshotId'));
      } catch (error) {
        return operationError(c, error);
      }
      return c.body(null, 204);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/restore', tags: ['apps'], summary: 'Restore an App snapshot', ...auth,
      description:
        'Capability `restore`. Rolls the App back to one of its snapshots: every change after it is lost. Answers when ' +
        'the machine runs the snapshot and answers again. A snapshot taken before an applied resize answers 409 ' +
        '`snapshot_predates_resize`; 409 `app_busy` while another operation runs. Read the admin credentials again ' +
        'afterwards when they were ever rotated.',
      request: {
        params: AppParams,
        body: { content: { 'application/json': { schema: z.object({ snapshot_id: z.string().min(1) }) } }, required: true },
      },
      responses: { 200: json(AppResult, 'App'), ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const found = await capableApp(c, 'admin', 'restore');
      if (found instanceof Response) return found;
      try {
        await restoreBackendSnapshot(found.row, c.req.valid('json').snapshot_id);
      } catch (error) {
        return operationError(c, error);
      }
      return c.json(await appJson(found.app), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/credentials', tags: ['apps'], summary: 'Reveal App admin credentials', ...auth,
      description:
        'Capability `admin_credentials`. The admin key controls the App\'s code and data. Every read is audited ' +
        '(`app.credentials.read`) and answers `Cache-Control: no-store`.',
      request: { params: AppParams },
      responses: { 200: json(Credentials, 'Credentials'), ...errors(403, 404, 409) },
    }),
    async (c) => {
      const found = await capableApp(c, 'admin', 'admin_credentials');
      if (found instanceof Response) return found;
      const { row, loaded } = found;
      const { adminKeyEnc } = row;
      if (row.status !== 'running' || !row.url || !row.siteUrl || !adminKeyEnc) return notRunning(c, row);
      const adminKey = backendAdminKey({ ...row, adminKeyEnc });
      const { url, siteUrl } = backendPublicUrls(row.appId);
      c.header('Cache-Control', 'no-store');
      await recordAuditEvent({
        accountId: loaded.row.accountId,
        projectId: row.projectId,
        actorUserId: loaded.userId,
        action: 'app.credentials.read',
        resourceType: 'app',
        resourceId: row.appId,
        metadata: { slug: row.slug },
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
      method: 'post', path: '/{projectId}/apps/{appId}/rotate-credentials', tags: ['apps'], summary: 'Rotate App admin credentials', ...auth,
      description:
        'Capability `admin_credentials`. Replaces the admin key: every key read before stops working (401). The ' +
        'machine restarts (about 1 s; clients reconnect). Data, files and environment variables stay. Read the new ' +
        'key from `credentials`. A restore of an App whose key was ever rotated rotates it again.',
      request: { params: AppParams },
      responses: { 200: json(AppResult, 'App'), ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const found = await capableApp(c, 'admin', 'admin_credentials');
      if (found instanceof Response) return found;
      try {
        await rotateBackendAdminKey(found.row);
      } catch (error) {
        return operationError(c, error);
      }
      return c.json(await appJson(found.app), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/token', tags: ['apps'], summary: 'Mint a sign-in token for an App', ...auth,
      description:
        `Capability \`member_tokens\`. A ${TOKEN_TTL_SECONDS / 60}-minute ES256 JWT from the project issuer ` +
        '(`iss` = `<API origin>/v1/projects/{projectId}`, `aud` = the App id) naming the caller (`sub` = Kortix user id, ' +
        '`email`, `role`, `groups`). The App verifies it with its `auth` values. An agent session gets a token naming ' +
        'its agent (`sub` = service account id, `kind: "agent"`, no role, no groups), never the human who launched it.',
      request: { params: AppParams },
      responses: { 200: json(MemberToken, 'Token'), ...errors(403, 404, 409) },
    }),
    async (c) => {
      const { projectId, appId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, 'read');
      if (loaded instanceof Response) return loaded;
      const app = await visibleApp(projectId, appId, loaded.userId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      const refusal = capabilityRefusal(c, app, 'member_tokens');
      if (refusal) return refusal;
      // An agent session's credential names the human who launched it. A token
      // for that id would carry the human's role and groups, so the agent gets
      // one naming its own service account, with no role and no groups.
      const { credential } = await actorOf(c, app.accountId);
      const minted = await mintAppToken(
        app,
        credential.kind === 'agent_session'
          ? { userId: credential.serviceAccountId, email: null, kind: 'agent' }
          : { userId: loaded.userId, ...(await resolveAppViewerIdentity(loaded.userId, app.accountId)) },
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ token: minted.token, expires_at: minted.expiresAt.toISOString() }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/logs', tags: ['apps'], summary: 'Read the App process log', ...auth,
      description:
        'Capability `logs`. The last lines of the App\'s process log: startup, crashes, restarts, request lines. ' +
        'Request lines and errors can carry data, so it needs project.app.write.',
      request: {
        params: AppParams,
        query: z.object({
          lines: z.coerce.number().int().min(1).max(MAX_LOG_LINES).default(200).openapi({
            description: `How many lines, newest last. 1 to ${MAX_LOG_LINES}, default 200.`,
          }),
        }),
      },
      responses: { 200: json(z.object({ log: z.string() }), 'Log'), ...errors(400, 403, 404, 409, 502, 503) },
    }),
    async (c) => {
      const found = await capableApp(c, 'write', 'logs');
      if (found instanceof Response) return found;
      try {
        const log = await readBackendLog(found.row, c.req.valid('query').lines);
        c.header('Cache-Control', 'no-store');
        return c.json({ log }, 200);
      } catch (error) {
        return operationError(c, error);
      }
    },
  );
}
