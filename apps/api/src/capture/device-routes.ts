/**
 * Capture device sign-in (RFC 8628 device authorization grant) and the
 * credential endpoint, mounted at `/v1/capture`.
 *
 * Device (public, no Kortix session):
 *   POST /device/authorize   → device_code, user_code, verification_uri(_complete), interval, expires_in
 *   POST /device/token       → RFC 8628 errors until approved, then {device_token, prefix, device_id}
 *   POST /credentials        (Bearer device token) → scoped S3 credentials, see credentials.ts
 *
 * Person (signed in, the approval page):
 *   GET  /device/grants/:user_code           → what is asking
 *   POST /device/grants/:user_code/approve   {project_id} → pairs the device to the caller in that project
 *   POST /device/grants/:user_code/deny
 *
 * One device row per (project, machine_key_sha256, member): signing in again
 * reuses the row (same device_id, same S3 folder) and replaces its token. The
 * token is stored only as `hashSecretKey(token)` and dies on revoke.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { captureDeviceGrants, captureDevices, projects } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { config } from '../config';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { featureDisabledBody } from '../feature-flags/gate';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { loadProjectForUser } from '../projects/lib/access';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { supabaseAuth } from '../middleware/auth';
import { requestClientKey } from '../shared/client-ip';
import { generateDeviceCode, hashSecretKey, randomAlphanumeric } from '../shared/crypto';
import { db } from '../shared/db';
import { readJsonObject } from '../shared/http-body';
import { logger } from '../lib/logger';
import { tunnelRateLimiter } from '../tunnel/core/rate-limiter';
import type { AppEnv } from '../types';
import { captureCredentialIssuer } from './credentials';
import { deviceFields, projectPrefix } from './format';
import { ensurePolicyObject } from './policy';

const GRANT_TTL_MS = 15 * 60_000;
/** RFC 8628 §3.2 default. `slow_down` answers a poll faster than this. */
const POLL_INTERVAL_S = 5;
const TOKEN_PREFIX = 'kortix_cap_';

const rfcError = (c: Context, error: string, description: string, status: 400 | 401 | 403 | 429 = 400) =>
  c.json({ error, error_description: description }, status);

/** Form-encoded (RFC 8628) or JSON body, as a flat string map. */
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await c.req.parseBody().catch(() => ({}));
    return Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === 'string'));
  }
  return readJsonObject(c);
}

function limited(c: Context, endpoint: string, key: string): Response | null {
  const verdict = tunnelRateLimiter.check(endpoint, key);
  if (verdict.allowed) return null;
  return rfcError(c, 'slow_down', `Too many requests; retry in ${Math.ceil((verdict.retryAfterMs ?? 1000) / 1000)} s`, 429);
}

export function verificationUri(): string {
  return `${(config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/capture/authorize`;
}

/** The device behind a bearer device token, or null. Always read from the row: a revoke on any replica wins. */
export async function deviceForToken(header: string | undefined) {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [device] = await db
    .select()
    .from(captureDevices)
    .where(and(eq(captureDevices.tokenHash, hashSecretKey(token)), isNull(captureDevices.revokedAt)))
    .limit(1);
  return device ?? null;
}

const GrantView = z.object({
  user_code: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'consumed', 'expired']),
  expires_at: z.string(),
  device: z.object({
    name: z.string().nullable(),
    os: z.string().nullable(),
    os_version: z.string().nullable(),
    arch: z.string().nullable(),
    app_version: z.string().nullable(),
  }),
  project_id: z.string().nullable(),
  device_id: z.string().nullable(),
});

function grantView(grant: typeof captureDeviceGrants.$inferSelect) {
  const fields = deviceFields(grant.deviceInfo);
  return {
    user_code: grant.userCode,
    status: grant.status === 'pending' && grant.expiresAt.getTime() < Date.now() ? 'expired' : grant.status,
    expires_at: grant.expiresAt.toISOString(),
    device: {
      name: fields.name,
      os: fields.os,
      os_version: fields.osVersion,
      arch: fields.arch,
      app_version: fields.appVersion,
    },
    project_id: grant.projectId,
    device_id: grant.deviceId,
  } as z.infer<typeof GrantView>;
}

const normalizeUserCode = (raw: string) => raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

async function grantByUserCode(userCode: string) {
  const [grant] = await db
    .select()
    .from(captureDeviceGrants)
    .where(eq(captureDeviceGrants.userCode, normalizeUserCode(userCode)))
    .limit(1);
  return grant ?? null;
}

/** A person, not an agent or a service: approval pairs the device to this human. */
function humanCaller(c: Context): boolean {
  const authType = c.get('authType') as string | undefined;
  return (authType === 'supabase' || authType === 'pat') && !callerKortixSessionId(c);
}

export function createCaptureRouter() {
  const app = makeOpenApiApp<AppEnv>();

  app.openapi(
    createRoute({
      method: 'post',
      path: '/device/authorize',
      tags: ['capture'],
      summary: 'Start a capture device sign-in (RFC 8628 device authorization request)',
      request: {
        body: {
          required: false,
          content: {
            'application/json': {
              schema: z.object({
                machine_key_sha256: z.string().describe('sha256 hex of the machine key; never the raw OS id'),
                hostname: z.string().optional(),
                computer_name: z.string().optional(),
                os: z.string().optional(),
                os_version: z.string().optional(),
                arch: z.string().optional(),
                app_version: z.string().optional(),
              }).passthrough(),
            },
          },
        },
      },
      responses: {
        200: json(
          z.object({
            device_code: z.string(),
            user_code: z.string(),
            verification_uri: z.string(),
            verification_uri_complete: z.string(),
            interval: z.number(),
            expires_in: z.number(),
          }),
          'The device code to poll with and the user code to show',
        ),
        ...errors(400, 429),
      },
    }),
    async (c: any) => {
      const ip = requestClientKey(c);
      const blocked = limited(c, 'captureAuthorizeGlobal', 'global') ?? limited(c, 'captureAuthorize', ip);
      if (blocked) return blocked;
      const body = await readBody(c);
      const machineKey = typeof body.machine_key_sha256 === 'string' ? body.machine_key_sha256.toLowerCase() : '';
      if (!/^[0-9a-f]{64}$/.test(machineKey)) {
        return rfcError(c, 'invalid_request', 'machine_key_sha256 must be 64 hex characters');
      }
      const deviceInfo = Object.fromEntries(
        ['hostname', 'computer_name', 'os', 'os_version', 'arch', 'app_version']
          .filter((k) => typeof body[k] === 'string')
          .map((k) => [k, String(body[k]).slice(0, 200)]),
      );
      const deviceCode = randomAlphanumeric(43);
      const expiresAt = new Date(Date.now() + GRANT_TTL_MS);
      let userCode = '';
      // The user code has a unique index: retry the rare collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        userCode = generateDeviceCode();
        try {
          await db.insert(captureDeviceGrants).values({
            deviceCodeHash: hashSecretKey(deviceCode),
            userCode,
            machineKeySha256: machineKey,
            deviceInfo,
            expiresAt,
          });
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== '23505' || attempt === 4) throw error;
        }
      }
      const uri = verificationUri();
      return c.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: uri,
        verification_uri_complete: `${uri}?user_code=${encodeURIComponent(userCode)}`,
        interval: POLL_INTERVAL_S,
        expires_in: Math.floor(GRANT_TTL_MS / 1000),
      });
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/device/token',
      tags: ['capture'],
      summary: 'Poll a capture device sign-in (RFC 8628 device access token request)',
      request: {
        body: {
          required: false,
          content: {
            'application/json': {
              schema: z.object({ device_code: z.string(), grant_type: z.string().optional() }).passthrough(),
            },
          },
        },
      },
      responses: {
        200: json(
          z.object({
            device_token: z.string(),
            token_type: z.literal('Bearer'),
            prefix: z.string(),
            device_id: z.string(),
          }),
          'The device token and the folder the device writes to',
        ),
        ...errors(400, 429),
      },
    }),
    async (c: any) => {
      const body = await readBody(c);
      const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
      if (!deviceCode) return rfcError(c, 'invalid_request', 'device_code is required');
      const blocked = limited(c, 'capturePoll', `${requestClientKey(c)}:${deviceCode.slice(0, 12)}`);
      if (blocked) return blocked;
      const [grant] = await db
        .select()
        .from(captureDeviceGrants)
        .where(eq(captureDeviceGrants.deviceCodeHash, hashSecretKey(deviceCode)))
        .limit(1);
      if (!grant || grant.status === 'consumed') return rfcError(c, 'invalid_grant', 'Unknown or already used device_code');
      if (grant.status === 'denied') return rfcError(c, 'access_denied', 'The sign-in was denied');
      if (grant.expiresAt.getTime() < Date.now()) return rfcError(c, 'expired_token', 'The sign-in expired; start again');

      if (grant.status === 'pending') {
        const tooSoon = grant.lastPolledAt && Date.now() - grant.lastPolledAt.getTime() < POLL_INTERVAL_S * 1000;
        await db
          .update(captureDeviceGrants)
          .set({ lastPolledAt: sql`now()` })
          .where(eq(captureDeviceGrants.grantId, grant.grantId));
        return tooSoon
          ? rfcError(c, 'slow_down', `Poll at most every ${POLL_INTERVAL_S} s`)
          : rfcError(c, 'authorization_pending', 'Waiting for a person to approve the sign-in');
      }

      // Approved: consume the grant exactly once, then mint the device token.
      const token = `${TOKEN_PREFIX}${randomAlphanumeric(40)}`;
      const minted = await db.transaction(async (tx) => {
        const [consumed] = await tx
          .update(captureDeviceGrants)
          .set({ status: 'consumed' })
          .where(and(eq(captureDeviceGrants.grantId, grant.grantId), eq(captureDeviceGrants.status, 'approved')))
          .returning({ deviceId: captureDeviceGrants.deviceId });
        if (!consumed?.deviceId) return null;
        const [device] = await tx
          .update(captureDevices)
          .set({ tokenHash: hashSecretKey(token), tokenIssuedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(captureDevices.deviceId, consumed.deviceId), isNull(captureDevices.revokedAt)))
          .returning();
        return device ?? null;
      });
      if (!minted) return rfcError(c, 'invalid_grant', 'The sign-in is no longer valid; start again');
      return c.json({
        device_token: token,
        token_type: 'Bearer' as const,
        prefix: projectPrefix(minted.accountId, minted.projectId),
        device_id: minted.deviceId,
      });
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/credentials',
      tags: ['capture'],
      summary: "Short-lived S3 credentials scoped to the calling device's folder",
      ...auth,
      responses: {
        200: json(
          z.object({
            endpoint: z.string(),
            bucket: z.string(),
            region: z.string(),
            prefix: z.string(),
            device_id: z.string(),
            access_key_id: z.string(),
            secret_access_key: z.string(),
            session_token: z.string(),
            expires_at_ms: z.number(),
          }),
          'Credentials; refresh 5 minutes before expires_at_ms',
        ),
        ...errors(401, 403, 429, 502, 503),
      },
    }),
    async (c: any) => {
      const device = await deviceForToken(c.req.header('Authorization'));
      if (!device) return c.json({ error: 'Invalid or revoked device token; sign in again', code: 'capture_device_unauthorized' }, 401);
      const blocked = limited(c, 'captureCredentials', device.deviceId);
      if (blocked) return blocked;
      const [project] = await db
        .select({ metadata: projects.metadata, status: projects.status, accountId: projects.accountId })
        .from(projects)
        .where(eq(projects.projectId, device.projectId))
        .limit(1);
      if (!project || project.status === 'archived') {
        return c.json({ error: 'The project is gone; sign in again', code: 'capture_device_unauthorized' }, 401);
      }
      if (!resolveFeatureFlag(project.metadata, 'capture')) return c.json(featureDisabledBody('capture'), 403);
      const issuer = captureCredentialIssuer();
      if (!issuer) {
        return c.json(
          { error: 'This deployment issues no capture credentials (no capture store or STS role configured)', code: 'capture_credentials_unavailable' },
          503,
        );
      }
      try {
        const credentials = await issuer.issue({
          prefix: projectPrefix(device.accountId, device.projectId),
          deviceId: device.deviceId,
        });
        await db
          .update(captureDevices)
          .set({ lastCredentialsAt: sql`now()` })
          .where(eq(captureDevices.deviceId, device.deviceId));
        return c.json(credentials);
      } catch (error) {
        logger.error('[capture] credential issue failed', { deviceId: device.deviceId, error: String(error) });
        return c.json({ error: 'The credential issuer failed; retry with backoff', code: 'capture_issuer_failed' }, 502);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/device/grants/{user_code}',
      tags: ['capture'],
      summary: 'Read a pending capture device sign-in (approval page)',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: { params: z.object({ user_code: z.string() }) },
      responses: { 200: json(GrantView, 'The sign-in request'), ...errors(401, 403, 404, 429) },
    }),
    async (c: any) => {
      const blocked = limited(c, 'captureGrantRead', c.get('userId'));
      if (blocked) return blocked;
      if (!humanCaller(c)) return c.json({ error: 'Only a person can approve a capture device' }, 403);
      const grant = await grantByUserCode(c.req.param('user_code'));
      if (!grant) return c.json({ error: 'Unknown code' }, 404);
      return c.json(grantView(grant));
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/device/grants/{user_code}/approve',
      tags: ['capture'],
      summary: 'Approve a capture device sign-in into one of your projects',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: {
        params: z.object({ user_code: z.string() }),
        body: { content: { 'application/json': { schema: z.object({ project_id: z.string().uuid() }) } } },
      },
      responses: { 200: json(GrantView, 'The approved sign-in'), ...errors(400, 401, 403, 404, 409, 429) },
    }),
    async (c: any) => {
      const userId = c.get('userId') as string;
      const blocked = limited(c, 'captureGrantDecide', userId);
      if (blocked) return blocked;
      if (!humanCaller(c)) return c.json({ error: 'Only a person can approve a capture device' }, 403);
      const { project_id: projectId } = c.req.valid('json') as { project_id: string };
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      if (!resolveFeatureFlag(loaded.row.metadata, 'capture')) return c.json(featureDisabledBody('capture'), 403);
      const grant = await grantByUserCode(c.req.param('user_code'));
      if (!grant) return c.json({ error: 'Unknown code' }, 404);
      if (grant.status !== 'pending' || grant.expiresAt.getTime() < Date.now()) {
        return c.json({ error: `This sign-in is ${grantView(grant).status}`, code: 'capture_grant_not_pending' }, 409);
      }
      const fields = deviceFields(grant.deviceInfo);
      const approved = await db.transaction(async (tx) => {
        // One row per (project, machine, member). Signing in again revives it.
        const [device] = await tx
          .insert(captureDevices)
          .values({
            accountId: loaded.row.accountId,
            projectId,
            userId,
            machineKeySha256: grant.machineKeySha256,
            ...fields,
            deviceInfo: grant.deviceInfo,
          })
          .onConflictDoUpdate({
            target: [captureDevices.projectId, captureDevices.machineKeySha256, captureDevices.userId],
            set: { ...fields, revokedAt: null, revokedBy: null, updatedAt: sql`now()` },
          })
          .returning({ deviceId: captureDevices.deviceId });
        const [updated] = await tx
          .update(captureDeviceGrants)
          .set({ status: 'approved', projectId, userId, deviceId: device!.deviceId })
          .where(and(eq(captureDeviceGrants.grantId, grant.grantId), eq(captureDeviceGrants.status, 'pending')))
          .returning();
        return updated ?? null;
      });
      if (!approved) return c.json({ error: 'This sign-in was decided already', code: 'capture_grant_not_pending' }, 409);
      await ensurePolicyObject({ projectId, accountId: loaded.row.accountId });
      return c.json(grantView(approved));
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/device/grants/{user_code}/deny',
      tags: ['capture'],
      summary: 'Deny a capture device sign-in',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: { params: z.object({ user_code: z.string() }) },
      responses: { 200: json(GrantView, 'The denied sign-in'), ...errors(401, 403, 404, 409, 429) },
    }),
    async (c: any) => {
      const blocked = limited(c, 'captureGrantDecide', c.get('userId'));
      if (blocked) return blocked;
      if (!humanCaller(c)) return c.json({ error: 'Only a person can deny a capture device' }, 403);
      const grant = await grantByUserCode(c.req.param('user_code'));
      if (!grant) return c.json({ error: 'Unknown code' }, 404);
      const [denied] = await db
        .update(captureDeviceGrants)
        .set({ status: 'denied' })
        .where(and(eq(captureDeviceGrants.grantId, grant.grantId), eq(captureDeviceGrants.status, 'pending')))
        .returning();
      if (!denied) return c.json({ error: 'This sign-in was decided already', code: 'capture_grant_not_pending' }, 409);
      return c.json(grantView(denied));
    },
  );

  return app;
}
