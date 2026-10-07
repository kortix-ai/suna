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
 *   GET  /device/grants/:user_code           → what is asking, and the caller's accounts with Capture on
 *   POST /device/grants/:user_code/approve   {account_id?} → pairs the device to the caller in that account
 *                                            (optional when exactly one of the caller's accounts has Capture on)
 *   POST /device/grants/:user_code/deny
 *
 * The data side is devices.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { config } from '../config';
import { lookupEmailsByUserIds } from '../accounts/core/owner-emails';
import { logger } from '../lib/logger';
import { supabaseAuth } from '../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { callerKortixSessionId } from '../middleware/caller-session';
import { requestClientKey } from '../middleware/client-ip';
import { readJsonObject } from '../shared/http-body';
import { TokenBucketRateLimiter, type RateLimitPolicy } from '../shared/rate-limit';
import type { AppEnv } from '../types';
import { captureCredentialIssuer } from './credentials';
import {
  GRANT_TTL_MS,
  POLL_INTERVAL_S,
  approveDeviceGrant,
  denyDeviceGrant,
  deviceForToken,
  grantByUserCode,
  grantView,
  markCredentialsIssued,
  pollDeviceGrant,
  startDeviceGrant,
} from './devices';
import { accountPrefix } from './format';
import { CAPTURE_DISABLED, registerCaptureAgentRoutes } from './account-routes';
import { captureAccountsFor, captureEnabled, captureRole, isAccountMember } from './workspace';
import { ensurePolicyObject } from './policy';

/** RFC 8628 / RFC 6749 §5.2 error body. */
const RfcError = z.object({ error: z.string(), error_description: z.string().optional() });
const rfc = () => ({ 400: json(RfcError, 'RFC 8628 error'), 429: json(RfcError, 'Rate limited (slow_down)') });

const rfcError = (c: Context, error: string, description: string, status: 400 | 429 = 400) =>
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

// replica-local: limit × API replicas; stops runaway clients, not a quota.
const limiter = new TokenBucketRateLimiter('capture');
const LIMITS: Record<string, RateLimitPolicy> = {
  captureAuthorizeGlobal: { limit: 100, windowMs: 60_000 },
  captureAuthorize: { limit: 10, windowMs: 60_000 },
  capturePoll: { limit: 30, windowMs: 60_000 },
  captureCredentials: { limit: 30, windowMs: 60_000 },
  captureGrantRead: { limit: 30, windowMs: 60_000 },
  captureGrantDecide: { limit: 10, windowMs: 60_000 },
};

function limited(c: Context, endpoint: keyof typeof LIMITS, key: string): Response | null {
  const verdict = limiter.check(`${endpoint}:${key}`, LIMITS[endpoint]!);
  if (verdict.allowed) return null;
  return rfcError(c, 'slow_down', `Too many requests; retry in ${Math.ceil((verdict.retryAfterMs ?? 1000) / 1000)} s`, 429);
}

export function verificationUri(): string {
  return `${(config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/capture/authorize`;
}

/** A person, not an agent or a service: approval pairs the device to this human. */
function humanCaller(c: Context<AppEnv>): boolean {
  const authType = c.get('authType') as string | undefined;
  return (authType === 'supabase' || authType === 'pat') && !callerKortixSessionId(c);
}

const GrantSchema = z.object({
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
  account_id: z.string().nullable(),
  device_id: z.string().nullable(),
});

const AccountChoiceSchema = z.object({ account_id: z.string(), name: z.string() });



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
              schema: z
                .object({
                  client_id: z.string().optional(),
                  device: z.record(z.string(), z.any()).optional().describe('The engine nests the fields below here'),
                  machine_key_sha256: z.string().optional().describe('sha256 hex of the machine key; never the raw OS id'),
                  hostname: z.string().optional(),
                  computer_name: z.string().optional(),
                  os: z.string().optional(),
                  os_version: z.string().optional(),
                  arch: z.string().optional(),
                  app_version: z.string().optional(),
                })
                .passthrough(),
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
        ...rfc(),
      },
    }),
    async (c) => {
      const blocked = limited(c, 'captureAuthorizeGlobal', 'global') ?? limited(c, 'captureAuthorize', requestClientKey(c));
      if (blocked) return blocked as never;
      const raw = await readBody(c);
      // The engine sends `{client_id, device: {machine_key_sha256, hostname, …}}`; a flat body works too.
      const body = raw.device && typeof raw.device === 'object' ? (raw.device as Record<string, unknown>) : raw;
      const machineKey = typeof body.machine_key_sha256 === 'string' ? body.machine_key_sha256.toLowerCase() : '';
      if (!/^[0-9a-f]{64}$/.test(machineKey)) {
        return rfcError(c, 'invalid_request', 'machine_key_sha256 must be 64 hex characters') as never;
      }
      const deviceInfo = Object.fromEntries(
        ['hostname', 'computer_name', 'os', 'os_version', 'arch', 'app_version']
          .filter((key) => typeof body[key] === 'string')
          .map((key) => [key, String(body[key]).slice(0, 200)]),
      );
      const grant = await startDeviceGrant(machineKey, deviceInfo);
      const uri = verificationUri();
      return c.json(
        {
          device_code: grant.deviceCode,
          user_code: grant.userCode,
          verification_uri: uri,
          verification_uri_complete: `${uri}?user_code=${encodeURIComponent(grant.userCode)}`,
          interval: POLL_INTERVAL_S,
          expires_in: Math.floor(GRANT_TTL_MS / 1000),
        },
        200,
      );
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
            member: z.object({ email: z.string().nullable() }),
          }),
          'The device token and the folder the device writes to',
        ),
        ...rfc(),
      },
    }),
    async (c) => {
      const body = await readBody(c);
      const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
      if (!deviceCode) return rfcError(c, 'invalid_request', 'device_code is required') as never;
      const blocked = limited(c, 'capturePoll', `${requestClientKey(c)}:${deviceCode.slice(0, 12)}`);
      if (blocked) return blocked as never;
      const outcome = await pollDeviceGrant(deviceCode);
      if (outcome.kind !== 'token') {
        const description = {
          invalid_grant: 'Unknown or already used device_code; start again',
          access_denied: 'The sign-in was denied',
          expired_token: 'The sign-in expired; start again',
          slow_down: `Poll at most every ${POLL_INTERVAL_S} s`,
          authorization_pending: 'Waiting for a person to approve the sign-in',
        }[outcome.kind];
        return rfcError(c, outcome.kind, description) as never;
      }
      const email = (await lookupEmailsByUserIds([outcome.userId])).get(outcome.userId) ?? null;
      return c.json(
        {
          device_token: outcome.token,
          token_type: 'Bearer' as const,
          prefix: outcome.prefix,
          device_id: outcome.deviceId,
          member: { email },
        },
        200,
      );
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
            path_style: z.boolean(),
          }),
          'Credentials; refresh 5 minutes before expires_at_ms',
        ),
        ...errors(401, 403, 429, 502, 503),
      },
    }),
    async (c) => {
      const device = await deviceForToken(c.req.header('Authorization'));
      if (!device) {
        return c.json({ error: 'Invalid or revoked device token; sign in again', code: 'capture_device_unauthorized' }, 401);
      }
      const blocked = limited(c, 'captureCredentials', device.deviceId);
      if (blocked) return blocked as never;
      if (!(await isAccountMember(device.accountId, device.userId))) {
        return c.json({ error: 'The person left the account; sign in again', code: 'capture_device_unauthorized' }, 401);
      }
      if (!(await captureEnabled(device.accountId))) return c.json(CAPTURE_DISABLED, 403);
      const issuer = captureCredentialIssuer();
      if (!issuer) {
        return c.json(
          {
            error: 'This deployment issues no capture credentials (no capture store or STS role configured)',
            code: 'capture_credentials_unavailable',
          },
          503,
        );
      }
      try {
        const credentials = await issuer.issue({ prefix: accountPrefix(device.accountId), deviceId: device.deviceId });
        await markCredentialsIssued(device.deviceId);
        return c.json(credentials, 200);
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
      responses: {
        200: json(GrantSchema.extend({ accounts: z.array(AccountChoiceSchema) }), 'The sign-in request and the accounts it can sign into'),
        ...errors(401, 403, 404, 429),
      },
    }),
    async (c) => {
      const blocked = limited(c, 'captureGrantRead', c.get('userId') as string);
      if (blocked) return blocked as never;
      if (!humanCaller(c)) return c.json({ error: 'Only a person can approve a capture device' }, 403);
      const grant = await grantByUserCode(c.req.valid('param').user_code);
      if (!grant) return c.json({ error: 'Unknown code' }, 404);
      return c.json({ ...grantView(grant), accounts: await captureAccountsFor(c.get('userId') as string) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/device/grants/{user_code}/approve',
      tags: ['capture'],
      summary: 'Approve a capture device sign-in into one of your accounts',
      ...auth,
      middleware: [supabaseAuth] as const,
      request: {
        params: z.object({ user_code: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                account_id: z
                  .string()
                  .uuid()
                  .optional()
                  .describe('The account to sign the device into. Optional when exactly one of your accounts has Capture on.'),
              }),
            },
          },
        },
      },
      responses: { 200: json(GrantSchema, 'The approved sign-in'), ...errors(400, 401, 403, 404, 409, 429) },
    }),
    async (c) => {
      const userId = c.get('userId') as string;
      const blocked = limited(c, 'captureGrantDecide', userId);
      if (blocked) return blocked as never;
      if (!humanCaller(c)) return c.json({ error: 'Only a person can approve a capture device' }, 403);
      let accountId = c.req.valid('json').account_id;
      if (!accountId) {
        const choices = await captureAccountsFor(userId);
        if (choices.length !== 1) {
          return c.json(
            {
              error: choices.length ? 'Pick the account to sign the device into' : 'None of your accounts has Capture on',
              code: choices.length ? 'capture_account_required' : 'capture_disabled',
            },
            choices.length ? 400 : 403,
          );
        }
        accountId = choices[0]!.account_id;
      }
      if (!(await captureRole(accountId, userId))) return c.json({ error: 'Not found' }, 404);
      if (!(await captureEnabled(accountId))) return c.json(CAPTURE_DISABLED, 403);
      const grant = await grantByUserCode(c.req.valid('param').user_code);
      if (!grant) return c.json({ error: 'Unknown code' }, 404);
      if (grant.status !== 'pending' || grant.expiresAt.getTime() < Date.now()) {
        return c.json({ error: `This sign-in is ${grantView(grant).status}`, code: 'capture_grant_not_pending' }, 409);
      }
      const approved = await approveDeviceGrant(grant, { accountId, userId });
      if (!approved) return c.json({ error: 'This sign-in was decided already', code: 'capture_grant_not_pending' }, 409);
      await ensurePolicyObject(accountId);
      return c.json(grantView(approved), 200);
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
      responses: { 200: json(GrantSchema, 'The denied sign-in'), ...errors(401, 403, 404, 409, 429) },
    }),
    async (c) => {
      const blocked = limited(c, 'captureGrantDecide', c.get('userId') as string);
      if (blocked) return blocked as never;
      if (!humanCaller(c)) return c.json({ error: 'Only a person can deny a capture device' }, 403);
      const grant = await grantByUserCode(c.req.valid('param').user_code);
      if (!grant) return c.json({ error: 'Unknown code' }, 404);
      const denied = await denyDeviceGrant(grant);
      if (!denied) return c.json({ error: 'This sign-in was decided already', code: 'capture_grant_not_pending' }, 409);
      return c.json(grantView(denied), 200);
    },
  );

  registerCaptureAgentRoutes(app);
  return app;
}
