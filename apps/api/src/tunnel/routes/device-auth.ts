/**
 * Device Auth Routes — browser-based authorization for tunnel connections.
 *
 * Public (no auth):
 *   POST   /                     — create device auth request (CLI calls this)
 *   GET    /:code/status         — poll for approval (CLI polls this)
 *
 * Authenticated:
 *   GET    /device-auth/:code/info    — fetch request details (browser approval page)
 *   POST   /device-auth/:code/approve — approve and create tunnel
 *   POST   /device-auth/:code/deny    — deny request
 */

import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import { eq, and, gt } from 'drizzle-orm';
import { tunnelConnections, tunnelDeviceAuthRequests, tunnelPermissions } from '@kortix/db';
import { sharedConfig as config, sharedDb as db } from '../../shared/effect';
import { generateDeviceCode, generateTunnelToken, hashSecretKey, verifySecretKey, randomAlphanumeric } from '../../shared/crypto';
import { tunnelRateLimiter } from '../core/rate-limiter';
import { resolveAccountId } from '../../shared/resolve-account';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { requireUserCredentialEffect } from './auth';
import { reconcileComputerConnectors } from '../../executor/sync';
import {
  attemptTunnel,
  attemptTunnelSync,
  parseOptionalJsonBody,
  runTunnelEffect,
  sendTunnelJson,
  tunnelFail,
  tunnelJson,
} from './effect-workflows';

const DEVICE_AUTH_TTL_MS = 5 * 60_000;

const DEFAULT_PERMISSION_SCOPES: Record<string, Record<string, unknown>[]> = {
  filesystem: [
    { scope: 'files:read', operations: ['read', 'list'] },
    { scope: 'files:write', operations: ['write'] },
    { scope: 'files:delete', operations: ['delete'] },
  ],
  shell: [
    { scope: 'shell:exec' },
  ],
  desktop: [
    { scope: 'desktop:computer_use', features: ['computer_use'] },
    { scope: 'desktop:apps', features: ['apps', 'windows'] },
    { scope: 'desktop:observe', features: ['screenshot', 'windows', 'accessibility'] },
    { scope: 'desktop:input', features: ['mouse', 'keyboard', 'accessibility'] },
  ],
};

/** Permissive device-auth request row shape, as persisted + serialized. */
const DeviceAuthRowSchema = z.record(z.string(), z.any());

const createDeviceAuthRequestEffect = (c: any) =>
  Effect.gen(function* () {
    const ip = 'public-device-auth-create';
    const globalRl = tunnelRateLimiter.check('deviceAuthCreateGlobal', 'global');
    if (!globalRl.allowed) {
      return yield* tunnelFail({ error: 'Too many requests', retryAfterMs: globalRl.retryAfterMs }, 429);
    }
    const rl = tunnelRateLimiter.check('deviceAuthCreate', ip);
    if (!rl.allowed) {
      return yield* tunnelFail({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
    }

    const body = yield* parseOptionalJsonBody<{ machineHostname?: string }>(c, {});
    const machineHostname = (body.machineHostname as string)?.slice(0, 255) || null;

    // Generate code + secret
    const deviceCode = yield* attemptTunnelSync(() => generateDeviceCode());
    const deviceSecret = yield* attemptTunnelSync(() => randomAlphanumeric(32));
    const deviceSecretHash = yield* attemptTunnelSync(() => hashSecretKey(deviceSecret));
    const expiresAt = new Date(Date.now() + DEVICE_AUTH_TTL_MS);

    yield* attemptTunnel(() =>
      db.insert(tunnelDeviceAuthRequests).values({
        deviceCode,
        deviceSecretHash,
        machineHostname,
        expiresAt,
      }),
    );

    const appUrl = config.FRONTEND_URL || 'http://localhost:3000';

    return tunnelJson({
      deviceCode,
      deviceSecret,
      verificationUrl: `${appUrl}/tunnel/authorize/${deviceCode}`,
      expiresAt: expiresAt.toISOString(),
      pollIntervalMs: 2000,
    }, 201);
  });

const pollDeviceAuthStatusEffect = (c: any) =>
  Effect.gen(function* () {
    const code = c.req.param('code');
    const authHeader = c.req.header('Authorization');
    const bearerSecret = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;
    const querySecret = c.req.query('secret');
    const secret = bearerSecret || querySecret;

    if (!secret) {
      return yield* tunnelFail({ error: 'device auth secret required' }, 400);
    }

    const rl = tunnelRateLimiter.check('deviceAuthPoll', code);
    if (!rl.allowed) {
      return yield* tunnelFail({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
    }

    const [row] = yield* attemptTunnel(() =>
      db
        .select()
        .from(tunnelDeviceAuthRequests)
        .where(eq(tunnelDeviceAuthRequests.deviceCode, code)),
    );

    if (!row) {
      return tunnelJson({ status: 'not_found' }, 404);
    }

    // Verify the secret
    const isValidSecret = yield* attemptTunnelSync(() => verifySecretKey(secret, row.deviceSecretHash));
    if (!isValidSecret) {
      return yield* tunnelFail({ error: 'Invalid secret' }, 403);
    }

    if (row.status === 'denied') {
      return tunnelJson({ status: 'denied' });
    }

    if (row.status === 'approved' && row.tunnelId && row.setupToken) {
      return tunnelJson({
        status: 'approved',
        tunnelId: row.tunnelId,
        token: row.setupToken,
      });
    }

    if (row.status === 'approved' && row.tunnelId) {
      return tunnelJson({
        status: 'approved',
        tunnelId: row.tunnelId,
      });
    }

    // Pending requests expire. Approved requests stay pollable for the CLI
    // handoff window so retrying or duplicate pollers cannot strand the user.
    if (row.expiresAt < new Date()) {
      return tunnelJson({ status: 'expired' });
    }

    return tunnelJson({ status: 'pending' });
  });

const getDeviceAuthInfoEffect = (c: any) =>
  Effect.gen(function* () {
    yield* requireUserCredentialEffect(c);
    const code = c.req.param('code');

    const [row] = yield* attemptTunnel(() =>
      db
        .select({
          deviceCode: tunnelDeviceAuthRequests.deviceCode,
          machineHostname: tunnelDeviceAuthRequests.machineHostname,
          status: tunnelDeviceAuthRequests.status,
          expiresAt: tunnelDeviceAuthRequests.expiresAt,
          createdAt: tunnelDeviceAuthRequests.createdAt,
        })
        .from(tunnelDeviceAuthRequests)
        .where(eq(tunnelDeviceAuthRequests.deviceCode, code)),
    );

    if (!row) {
      return yield* tunnelFail({ error: 'Device auth request not found' }, 404);
    }

    if (row.expiresAt < new Date() && row.status === 'pending') {
      return tunnelJson({ ...row, status: 'expired' });
    }

    return tunnelJson(row);
  });

const approveDeviceAuthEffect = (c: any) =>
  Effect.gen(function* () {
    yield* requireUserCredentialEffect(c);
    const userId = c.get('userId') as string;
    const accountId = yield* attemptTunnel(() => resolveAccountId(userId));
    const code = c.req.param('code');
    const body = yield* parseOptionalJsonBody<{
      name?: string;
      capabilities?: string[];
    }>(c, {});

    const [row] = yield* attemptTunnel(() =>
      db
        .select()
        .from(tunnelDeviceAuthRequests)
        .where(
          and(
            eq(tunnelDeviceAuthRequests.deviceCode, code),
            eq(tunnelDeviceAuthRequests.status, 'pending'),
            gt(tunnelDeviceAuthRequests.expiresAt, new Date()),
          ),
        ),
    );

    if (!row) {
      return yield* tunnelFail({ error: 'Device auth request not found or expired' }, 404);
    }

    const name = (body.name as string) || row.machineHostname || 'Unnamed';
    const capabilities = (body.capabilities as string[]) || [];

    // Create tunnel connection (same as POST /connections)
    const setupToken = yield* attemptTunnelSync(() => generateTunnelToken());
    const setupTokenHash = yield* attemptTunnelSync(() => hashSecretKey(setupToken));

    const [connection] = yield* attemptTunnel(() =>
      db
        .insert(tunnelConnections)
        .values({
          accountId,
          name,
          capabilities,
          status: 'offline',
          setupTokenHash,
        })
        .returning(),
    );

    // Grant the same granular scopes shown in the Computers UI so approval
    // state and the permission toggles start in sync.
    if (capabilities.length > 0) {
      const grants = capabilities.flatMap((cap: string) => {
        const scopes = DEFAULT_PERMISSION_SCOPES[cap] ?? [{}];
        return scopes.map((scope) => ({
          tunnelId: connection.tunnelId,
          accountId,
          capability: cap as any,
          scope,
          status: 'active' as const,
        }));
      });
      yield* attemptTunnel(() => db.insert(tunnelPermissions).values(grants));
    }

    // Update device auth row with approval + token
    yield* attemptTunnel(() =>
      db
        .update(tunnelDeviceAuthRequests)
        .set({
          status: 'approved',
          accountId,
          tunnelId: connection.tunnelId,
          setupToken,
          updatedAt: new Date(),
        })
        .where(eq(tunnelDeviceAuthRequests.id, row.id)),
    );

    yield* Effect.sync(() => {
      // Materialize the account's `computer` Executor connector (first machine).
      void reconcileComputerConnectors(accountId);
    });

    return tunnelJson({ success: true, tunnelId: connection.tunnelId });
  });

const denyDeviceAuthEffect = (c: any) =>
  Effect.gen(function* () {
    yield* requireUserCredentialEffect(c);
    const code = c.req.param('code');

    const [updated] = yield* attemptTunnel(() =>
      db
        .update(tunnelDeviceAuthRequests)
        .set({ status: 'denied', updatedAt: new Date() })
        .where(
          and(
            eq(tunnelDeviceAuthRequests.deviceCode, code),
            eq(tunnelDeviceAuthRequests.status, 'pending'),
          ),
        )
        .returning(),
    );

    if (!updated) {
      return yield* tunnelFail({ error: 'Device auth request not found or already resolved' }, 404);
    }

    return tunnelJson({ success: true });
  });

/**
 * Public router — mounted BEFORE auth middleware.
 * Handles create + poll (unauthenticated, used by CLI).
 */
export function createDeviceAuthPublicRouter() {
  const router = makeOpenApiApp<AppEnv>();

  // POST / — create device auth request (no platform auth; device-code flow)
  router.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['tunnel'],
      summary: 'Create a device-auth request (public; CLI device-code flow)',
      request: {
        body: {
          required: false,
          content: {
            'application/json': {
              schema: z.object({ machineHostname: z.string().optional() }),
            },
          },
        },
      },
      responses: {
        201: json(
          z.object({
            deviceCode: z.string(),
            deviceSecret: z.string(),
            verificationUrl: z.string(),
            expiresAt: z.string(),
            pollIntervalMs: z.number(),
          }),
          'The device code + one-time secret to poll with',
        ),
        ...errors(429),
      },
    }),
    async (c: any) => {
      return sendTunnelJson(c, await runTunnelEffect(createDeviceAuthRequestEffect(c)));
    },
  );

  // GET /:code/status — poll for approval (public; auth header carries the device secret)
  router.openapi(
    createRoute({
      method: 'get',
      path: '/{code}/status',
      tags: ['tunnel'],
      summary: 'Poll a device-auth request for approval (public)',
      request: { params: z.object({ code: z.string() }) },
      responses: {
        200: json(
          z.object({
            status: z.string(),
            tunnelId: z.string().optional(),
            token: z.string().optional(),
          }),
          'Current device-auth status (pending/approved/denied/expired)',
        ),
        ...errors(400, 403, 404, 429),
      },
    }),
    async (c: any) => {
      return sendTunnelJson(c, await runTunnelEffect(pollDeviceAuthStatusEffect(c)));
    },
  );

  return router;
}

/**
 * Authenticated router — mounted inside tunnelApp (behind combinedAuth).
 * Handles info, approve, deny.
 */
export function createDeviceAuthRouter() {
  const router = makeOpenApiApp<AppEnv>();

  // GET /:code/info — fetch request details for approval page
  router.openapi(
    createRoute({
      method: 'get',
      path: '/{code}/info',
      tags: ['tunnel'],
      summary: 'Fetch device-auth request details (approval page)',
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ code: z.string() }) },
      responses: {
        200: json(DeviceAuthRowSchema, 'The device-auth request details'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      return sendTunnelJson(c, await runTunnelEffect(getDeviceAuthInfoEffect(c)));
    },
  );

  // POST /:code/approve — approve and create tunnel + token
  router.openapi(
    createRoute({
      method: 'post',
      path: '/{code}/approve',
      tags: ['tunnel'],
      summary: 'Approve a device-auth request (creates tunnel + grants capabilities)',
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ code: z.string() }),
        body: {
          required: false,
          content: {
            'application/json': {
              schema: z.object({
                name: z.string().optional(),
                capabilities: z.array(z.string()).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(
          z.object({ success: z.boolean(), tunnelId: z.string() }),
          'The created tunnel id',
        ),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      return sendTunnelJson(c, await runTunnelEffect(approveDeviceAuthEffect(c)));
    },
  );

  // POST /:code/deny — deny request
  router.openapi(
    createRoute({
      method: 'post',
      path: '/{code}/deny',
      tags: ['tunnel'],
      summary: 'Deny a pending device-auth request',
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ code: z.string() }) },
      responses: {
        200: json(z.object({ success: z.boolean() }), 'Denial result'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      return sendTunnelJson(c, await runTunnelEffect(denyDeviceAuthEffect(c)));
    },
  );

  return router;
}
