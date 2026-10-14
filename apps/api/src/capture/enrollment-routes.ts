/**
 * Kortix Capture IT rollout routes. The data side is enrollment.ts.
 *
 * Device (public, the enrollment token in the body), on `/v1/capture`:
 *   POST /device/enroll   → 200 enrolled (device token; `member` null while linked to no one) · 202 pending · 401/403 refused
 *
 * Admin (`capture.manage`), on `/v1/accounts/:accountId/capture`:
 *   GET    /enrollment-tokens              · POST /enrollment-tokens (the token is shown once)
 *   DELETE /enrollment-tokens/:tokenId     (revoke; enrolled computers keep recording)
 *   GET    /enrollments?status=pending     (computers that wait for a decision)
 *   POST   /enrollments/:id/approve {user_id?} · POST /enrollments/:id/deny
 */
import { createHash } from 'crypto';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { accountsRouter } from '../accounts/core/app';
import { auth, errors, json } from '../openapi';
import { annotateAuditEvent, bindAuditPrincipal } from '../shared/audit-scope';
import { readJsonObject } from '../shared/http-body';
import { TokenBucketRateLimiter, type RateLimitPolicy } from '../shared/rate-limit';
import { bearerToken } from '../shared/bearer-token';
import type { AppEnv } from '../types';
import { captureAccessWithPowers, isResponse, refuse, type Ctx } from './account-routes';
import {
  approveEnrollment,
  createEnrollmentToken,
  denyEnrollment,
  enroll,
  ENROLLMENT_TOKEN_SHAPE,
  enrollmentInAccount,
  enrollmentView,
  ENROLL_RETRY_S,
  listEnrollments,
  listEnrollmentTokens,
  normalizeDomains,
  revokeEnrollmentToken,
  tokenView,
} from './enrollment';
import { isAccountMember } from './workspace';

// replica-local: limit × API replicas; stops a runaway device, not a quota. Keyed by
// token and machine, never by IP: a company's computers share one NAT address.
const limiter = new TokenBucketRateLimiter('capture-enroll');
const LIMITS: Record<string, RateLimitPolicy> = {
  enrollToken: { limit: 600, windowMs: 60_000 },
  enrollMachine: { limit: 20, windowMs: 60_000 },
};

function limited(c: Context, endpoint: keyof typeof LIMITS, key: string): Response | null {
  const verdict = limiter.check(`${endpoint}:${key}`, LIMITS[endpoint]!);
  if (verdict.allowed) return null;
  const retry = Math.ceil((verdict.retryAfterMs ?? 1000) / 1000);
  return c.json({ error: 'slow_down', error_description: `Too many requests; retry in ${retry} s`, retry_after_s: retry }, 429);
}

const str = (value: unknown, max = 200) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

const EnrolledSchema = z.object({
  status: z.literal('enrolled'),
  device_token: z.string(),
  token_type: z.literal('Bearer'),
  prefix: z.string(),
  device_id: z.string(),
  account: z.object({ name: z.string() }),
  /** The member the device records for; null: linked to no one until an admin links it. */
  member: z.object({ email: z.string().nullable() }).nullable(),
});
const PendingSchema = z.object({
  status: z.literal('pending'),
  reason: z.enum(['approval_required']),
  enrollment_id: z.string(),
  retry_after_s: z.number(),
});
const RefusalSchema = z.object({ error: z.string(), code: z.string() });

/** The device half: one call enrolls the computer, or tells it to wait. */
export function registerDeviceEnrollRoute(app: OpenAPIHono<AppEnv>) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/device/enroll',
      tags: ['capture'],
      summary: 'Enroll a computer with an IT enrollment token, as the person signed in to it (no browser sign-in)',
      description:
        'Call again to poll: 202 pending answers carry retry_after_s. 200 always mints a new device token for the computer and person; the previous one stops working.',
      request: {
        body: {
          content: {
            'application/json': {
              // Every field optional here: the handler answers each missing one with the contract's 400.
              schema: z
                .object({
                  enrollment_token: z.any().optional().describe('kortix_enr_…'),
                  machine_key_sha256: z.any().optional().describe('sha256 hex of the machine key; never the raw OS id'),
                  user: z
                    .object({
                      principal_name: z.string().nullable().optional().describe('The Windows UPN, matched against member emails'),
                      account_name: z.string().nullable().optional().describe('The Windows login name (DOMAIN\\user)'),
                    })
                    .partial()
                    .passthrough()
                    .optional(),
                  device: z.record(z.string(), z.any()).optional(),
                })
                .passthrough(),
            },
          },
        },
      },
      responses: {
        200: json(EnrolledSchema, 'Enrolled: the device token and the folder the device writes to'),
        202: json(PendingSchema, 'Waiting for an admin: the token approves each computer, or an admin revoked this one'),
        400: json(RefusalSchema, 'invalid_request'),
        401: json(RefusalSchema, 'enrollment_token_invalid: unknown, revoked or expired'),
        403: json(RefusalSchema, 'enrollment_denied, enrollment_domain_not_allowed, enrollment_limit_reached or capture_disabled'),
        429: json(z.object({ error: z.string(), error_description: z.string(), retry_after_s: z.number() }), 'Rate limited'),
      },
    }),
    async (c) => {
      const body = await readJsonObject(c);
      const token = typeof body.enrollment_token === 'string' ? body.enrollment_token.trim() : '';
      const machineKey = typeof body.machine_key_sha256 === 'string' ? body.machine_key_sha256.toLowerCase() : '';
      const user = (body.user && typeof body.user === 'object' ? body.user : {}) as Record<string, unknown>;
      const device = (body.device && typeof body.device === 'object' ? body.device : {}) as Record<string, unknown>;
      if (!token) return c.json({ error: 'enrollment_token is required', code: 'invalid_request' }, 400);
      if (!/^[0-9a-f]{64}$/.test(machineKey)) {
        return c.json({ error: 'machine_key_sha256 must be 64 hex characters', code: 'invalid_request' }, 400);
      }
      // Cheap checks first: the machine limit, then the token's shape, before any costly hash.
      const blocked =
        limited(c, 'enrollMachine', machineKey) ?? limited(c, 'enrollToken', createHash('sha256').update(token).digest('hex').slice(0, 16));
      if (blocked) return blocked as never;
      if (!ENROLLMENT_TOKEN_SHAPE.test(token)) {
        return c.json({ error: 'Unknown, revoked or expired enrollment token', code: 'enrollment_token_invalid' }, 401);
      }
      const deviceInfo = Object.fromEntries(
        ['hostname', 'computer_name', 'os', 'os_version', 'arch', 'app_version']
          .map((key) => [key, str(device[key])] as const)
          .filter((entry): entry is readonly [string, string] => entry[1] !== null),
      );
      const outcome = await enroll({
        token,
        machineKey,
        principalName: str(user.principal_name, 320),
        accountName: str(user.account_name, 320),
        deviceInfo,
        deviceToken: bearerToken(c.req.header('Authorization'))?.trim() || null,
      });
      if ('accountId' in outcome) {
        // The token is the caller: an IdP-less machine has no Kortix user until it is matched.
        bindAuditPrincipal({
          accountId: outcome.accountId,
          actorUserId: null,
          actorType: 'system',
          authoritativeSource: 'capture_enrollment',
          authMethod: { kind: 'capture_enrollment_token', token_id: outcome.tokenId },
        });
        annotateAuditEvent({
          resourceType: 'capture_device',
          resourceId: outcome.kind === 'enrolled' ? outcome.deviceId : null,
          outcome: outcome.kind === 'enrolled' ? 'success' : outcome.kind === 'pending' ? 'pending' : 'denied',
          metadata: {
            result: outcome.kind,
            ...('enrollmentId' in outcome ? { enrollment_id: outcome.enrollmentId } : {}),
            ...(outcome.kind === 'enrolled' ? { member_user_id: outcome.userId } : {}),
          },
        });
      }
      switch (outcome.kind) {
        case 'enrolled':
          return c.json(
            {
              status: 'enrolled' as const,
              device_token: outcome.token,
              token_type: 'Bearer' as const,
              prefix: outcome.prefix,
              device_id: outcome.deviceId,
              account: { name: outcome.accountName },
              member: outcome.userId ? { email: outcome.memberEmail } : null,
            },
            200,
          );
        case 'pending':
          return c.json(
            { status: 'pending' as const, reason: outcome.reason, enrollment_id: outcome.enrollmentId, retry_after_s: ENROLL_RETRY_S },
            202,
          );
        case 'invalid_token':
          return c.json({ error: 'Unknown, revoked or expired enrollment token', code: 'enrollment_token_invalid' }, 401);
        case 'capture_disabled':
          return c.json({ error: 'Capture is off for this account', code: 'capture_disabled' }, 403);
        case 'bad_principal':
          return c.json({ error: 'user.principal_name or user.account_name is required', code: 'invalid_request' }, 400);
        case 'domain_not_allowed':
          return c.json({ error: 'This person’s email domain is not allowed by the enrollment token', code: 'enrollment_domain_not_allowed' }, 403);
        case 'limit_reached':
          return c.json({ error: 'The enrollment token reached its computer limit', code: 'enrollment_limit_reached' }, 403);
        case 'denied':
          return c.json({ error: 'An admin denied this computer', code: 'enrollment_denied' }, 403);
      }
    },
  );
}

// ─── Admin ───────────────────────────────────────────────────────────────────

const tags = ['capture'];
const params = z.object({ accountId: z.string().uuid() });

const TokenSchema = z.object({
  token_id: z.string(),
  name: z.string(),
  token_prefix: z.string(),
  state: z.enum(['active', 'revoked', 'expired']),
  email_domains: z.array(z.string()),
  max_devices: z.number().nullable(),
  device_count: z.number(),
  require_approval: z.boolean(),
  user_id: z.string().nullable(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});

const EnrollmentSchema = z.object({
  enrollment_id: z.string(),
  token_id: z.string(),
  token_name: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'denied', 'enrolled']),
  reason: z.enum(['approval_required']).nullable(),
  principal_name: z.string().nullable(),
  account_name: z.string().nullable(),
  device: z.object({
    name: z.string().nullable(),
    os: z.string().nullable(),
    os_version: z.string().nullable(),
    arch: z.string().nullable(),
    app_version: z.string().nullable(),
  }),
  user_id: z.string().nullable(),
  device_id: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
  last_seen_at: z.string(),
});

/** A person (not an agent) with `capture.manage` in the account, or the refusal. */
async function manager(c: Ctx) {
  const access = await captureAccessWithPowers(c);
  if (isResponse(access)) return access;
  if (access.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot manage the Capture rollout');
  if (!access.manages) return refuse(c, 403, 'capture_forbidden', 'Managing the Capture rollout needs the capture.manage permission');
  return access;
}

export function registerCaptureEnrollmentRoutes() {
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/enrollment-tokens',
      tags,
      summary: 'The account’s Capture enrollment tokens, newest first (capture.manage)',
      ...auth,
      request: { params },
      responses: { 200: json(z.object({ tokens: z.array(TokenSchema) }), 'The tokens'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const access = await manager(c);
      if (isResponse(access)) return access as never;
      return c.json({ tokens: await listEnrollmentTokens(access.accountId) }, 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/capture/enrollment-tokens',
      tags,
      summary: 'Create a Capture enrollment token for an IT rollout (capture.manage); the token is in this answer only',
      ...auth,
      request: {
        params,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string().trim().min(1).max(100),
                email_domains: z.array(z.string().max(253)).max(20).optional().describe('Allowed Windows sign-in domains; empty: any member'),
                max_devices: z.number().int().min(1).max(100_000).nullable().optional(),
                require_approval: z.boolean().optional().describe('Every new computer waits for an admin'),
                expires_in_days: z.number().int().min(1).max(365).nullable().optional().describe('Default 30; null: never expires'),
                user_id: z
                  .string()
                  .uuid()
                  .nullable()
                  .optional()
                  .describe('Link every computer this token enrolls to this member (a personal install). Absent: matched by sign-in email'),
              }),
            },
          },
        },
      },
      responses: { 201: json(TokenSchema.extend({ token: z.string() }), 'The token, shown once'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const access = await manager(c);
      if (isResponse(access)) return access as never;
      const body = c.req.valid('json');
      const emailDomains = normalizeDomains(body.email_domains ?? []);
      if (!emailDomains) return refuse(c, 400, 'capture_enrollment_invalid', 'email_domains must be domain names, like corp.example');
      const days = body.expires_in_days === undefined ? 30 : body.expires_in_days;
      const userId = body.user_id ?? null;
      if (userId && !(await isAccountMember(access.accountId, userId))) {
        return refuse(c, 400, 'capture_enrollment_invalid', 'user_id must be a member of the account');
      }
      const { row, token } = await createEnrollmentToken(
        access.accountId,
        {
          name: body.name,
          emailDomains,
          maxDevices: body.max_devices ?? null,
          requireApproval: body.require_approval ?? false,
          expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000),
          userId,
        },
        access.viewer,
      );
      annotateAuditEvent({ resourceType: 'capture_enrollment_token', resourceId: row.tokenId });
      return c.json({ ...tokenView(row, 0), token }, 201);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'delete',
      path: '/{accountId}/capture/enrollment-tokens/{tokenId}',
      tags,
      summary: 'Revoke a Capture enrollment token (capture.manage); computers it enrolled keep recording',
      ...auth,
      request: { params: params.extend({ tokenId: z.string().uuid() }) },
      responses: { 200: json(TokenSchema, 'The revoked token'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const access = await manager(c);
      if (isResponse(access)) return access as never;
      const tokenId = c.req.valid('param').tokenId;
      const revoked = await revokeEnrollmentToken(access.accountId, tokenId, access.viewer);
      if (!revoked) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
      annotateAuditEvent({ resourceType: 'capture_enrollment_token', resourceId: tokenId });
      return c.json(revoked, 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/capture/enrollments',
      tags,
      summary: 'Computers that presented an enrollment token, last seen first (capture.manage)',
      ...auth,
      request: { params, query: z.object({ status: z.enum(['pending', 'approved', 'denied', 'enrolled']).optional() }) },
      responses: { 200: json(z.object({ enrollments: z.array(EnrollmentSchema) }), 'The computers'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const access = await manager(c);
      if (isResponse(access)) return access as never;
      return c.json({ enrollments: await listEnrollments(access.accountId, c.req.valid('query').status) }, 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/capture/enrollments/{enrollmentId}/approve',
      tags,
      summary: 'Approve a waiting computer, optionally linked to a member (capture.manage); it enrolls at its next call, within a minute',
      ...auth,
      request: {
        params: params.extend({ enrollmentId: z.string().uuid() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({ user_id: z.string().uuid().nullable().optional().describe('Link the computer to this member; absent or null: record linked to no one') }),
            },
          },
        },
      },
      responses: { 200: json(EnrollmentSchema, 'The approved computer'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const access = await manager(c);
      if (isResponse(access)) return access as never;
      const { enrollmentId } = c.req.valid('param');
      const userId = c.req.valid('json').user_id ?? null;
      const found = await enrollmentInAccount(access.accountId, enrollmentId);
      if (!found) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
      if (userId && !(await isAccountMember(access.accountId, userId))) {
        return refuse(c, 400, 'capture_enrollment_invalid', 'user_id must be a member of the account');
      }
      annotateAuditEvent({ resourceType: 'capture_enrollment', resourceId: enrollmentId, metadata: { member_user_id: userId } });
      return c.json(enrollmentView(await approveEnrollment(found.row, userId, access.viewer), found.tokenName), 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/capture/enrollments/{enrollmentId}/deny',
      tags,
      summary: 'Deny a computer (capture.manage); a device it enrolled is revoked at once',
      ...auth,
      request: { params: params.extend({ enrollmentId: z.string().uuid() }) },
      responses: { 200: json(EnrollmentSchema, 'The denied computer'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const access = await manager(c);
      if (isResponse(access)) return access as never;
      const { enrollmentId } = c.req.valid('param');
      const found = await enrollmentInAccount(access.accountId, enrollmentId);
      if (!found) return c.json({ error: 'Not found', code: 'capture_not_found' }, 404);
      annotateAuditEvent({ resourceType: 'capture_enrollment', resourceId: enrollmentId });
      return c.json(enrollmentView(await denyEnrollment(found.row, access.viewer), found.tokenName), 200);
    },
  );
}
