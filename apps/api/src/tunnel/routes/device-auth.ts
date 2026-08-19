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
import { createHash } from 'node:crypto';
import { eq, and, gt } from 'drizzle-orm';
import { tunnelConnections, tunnelDeviceAuthRequests, tunnelPermissions } from '@kortix/db';
import { db } from '../../shared/db';
import {
  generateDeviceCode,
  deriveDeviceSetupToken,
  hashSecretKey,
  verifySecretKey,
  randomAlphanumeric,
} from '../../shared/crypto';
import { tunnelRateLimiter } from '../core/rate-limiter';
import { config } from '../../config';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json, errors } from '../../openapi';
import { getTunnelOwnerContext, requireUserCredential } from './auth';
import { isValidCapability } from '../core/scope-validator';
import { reconcileComputerConnectors } from '../../connectors/sync';

const DEVICE_AUTH_TTL_MS = 5 * 60_000;

const DEFAULT_PERMISSION_SCOPES: Record<string, Record<string, unknown>[]> = {
  filesystem: [
    { scope: 'files:read', operations: ['read', 'list'] },
    { scope: 'files:write', operations: ['write'] },
    { scope: 'files:delete', operations: ['delete'] },
  ],
  shell: [{ scope: 'shell:exec' }],
  desktop: [
    { scope: 'desktop:computer_use', features: ['computer_use'] },
    { scope: 'desktop:apps', features: ['apps', 'windows'] },
    {
      scope: 'desktop:observe',
      features: ['screenshot', 'windows', 'accessibility'],
    },
    {
      scope: 'desktop:input',
      features: ['mouse', 'keyboard', 'accessibility'],
    },
  ],
};

/** Permissive device-auth request row shape, as persisted + serialized. */
const DeviceAuthRowSchema = z.record(z.string(), z.any());

function clientRateLimitKey(c: any): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = c.req.header('x-real-ip')?.trim();
  const cfIp = c.req.header('cf-connecting-ip')?.trim();
  return cfIp || realIp || forwarded || 'unknown';
}

function devicePollRateLimitKey(c: any, secret: string): string {
  const secretId = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  return `${clientRateLimitKey(c)}:${secretId}`;
}

function checkDeviceAuthResolutionRateLimit(c: any, endpoint: string) {
  const userId = (c.get('userId') as string | undefined) ?? 'anonymous';
  const key = `${userId}:${clientRateLimitKey(c)}`;
  return tunnelRateLimiter.check(endpoint, key);
}

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
      const ip = clientRateLimitKey(c);
      const globalRl = tunnelRateLimiter.check('deviceAuthCreateGlobal', 'global');
      if (!globalRl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: globalRl.retryAfterMs }, 429);
      }
      const rl = tunnelRateLimiter.check('deviceAuthCreate', ip);
      if (!rl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
      }

      const body = await c.req.json().catch(() => ({}));
      const machineHostname = (body.machineHostname as string)?.slice(0, 255) || null;

      // Generate code + secret. The human code has a unique index, so retry
      // the rare collision instead of returning an internal error.
      let deviceCode = '';
      const deviceSecret = randomAlphanumeric(32);
      const deviceSecretHash = hashSecretKey(deviceSecret);
      const expiresAt = new Date(Date.now() + DEVICE_AUTH_TTL_MS);
      for (let attempt = 0; attempt < 5; attempt++) {
        deviceCode = generateDeviceCode();
        try {
          await db.insert(tunnelDeviceAuthRequests).values({
            deviceCode,
            deviceSecretHash,
            machineHostname,
            expiresAt,
          });
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== '23505' || attempt === 4) throw error;
        }
      }

      const appUrl = config.FRONTEND_URL || 'http://localhost:3000';

      return c.json(
        {
          deviceCode,
          deviceSecret,
          verificationUrl: `${appUrl}/tunnel/authorize/${deviceCode}`,
          expiresAt: expiresAt.toISOString(),
          pollIntervalMs: 2000,
        },
        201,
      );
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
            capabilities: z.array(z.string()).optional(),
          }),
          'Current device-auth status (pending/approved/denied/expired)',
        ),
        ...errors(400, 403, 404, 429),
      },
    }),
    async (c: any) => {
      const code = c.req.param('code');
      const authHeader = c.req.header('Authorization');
      const bearerSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const secret = bearerSecret;

      if (!secret) {
        return c.json({ error: 'device auth secret required' }, 400);
      }

      const rl = tunnelRateLimiter.check('deviceAuthPoll', devicePollRateLimitKey(c, secret));
      if (!rl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
      }

      const [row] = await db
        .select()
        .from(tunnelDeviceAuthRequests)
        .where(eq(tunnelDeviceAuthRequests.deviceCode, code));

      if (!row) {
        return c.json({ status: 'not_found' }, 404);
      }

      // Verify the secret
      if (!verifySecretKey(secret, row.deviceSecretHash)) {
        return c.json({ error: 'Invalid secret' }, 403);
      }

      if (row.expiresAt < new Date()) {
        return c.json({ status: 'expired' });
      }

      if (row.status === 'denied') {
        return c.json({ status: 'denied' });
      }

      if (row.status === 'approved' && row.tunnelId) {
        const [connection] = await db
          .select({ capabilities: tunnelConnections.capabilities })
          .from(tunnelConnections)
          .where(eq(tunnelConnections.tunnelId, row.tunnelId))
          .limit(1);
        return c.json({
          status: 'approved',
          tunnelId: row.tunnelId,
          token: row.setupToken ?? deriveDeviceSetupToken(row.deviceSecretHash, row.id),
          capabilities: connection?.capabilities ?? [],
        });
      }

      return c.json({ status: 'pending' });
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
      requireUserCredential(c);
      const rl = checkDeviceAuthResolutionRateLimit(c, 'deviceAuthInfo');
      if (!rl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
      }
      const code = c.req.param('code');

      const [row] = await db
        .select({
          deviceCode: tunnelDeviceAuthRequests.deviceCode,
          machineHostname: tunnelDeviceAuthRequests.machineHostname,
          status: tunnelDeviceAuthRequests.status,
          expiresAt: tunnelDeviceAuthRequests.expiresAt,
          createdAt: tunnelDeviceAuthRequests.createdAt,
        })
        .from(tunnelDeviceAuthRequests)
        .where(eq(tunnelDeviceAuthRequests.deviceCode, code));

      if (!row) {
        return c.json({ error: 'Device auth request not found' }, 404);
      }

      if (row.expiresAt < new Date() && row.status === 'pending') {
        return c.json({ ...row, status: 'expired' });
      }

      return c.json(row);
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
      requireUserCredential(c);
      const rl = checkDeviceAuthResolutionRateLimit(c, 'deviceAuthApprove');
      if (!rl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
      }
      const { accountId } = await getTunnelOwnerContext(c);
      const code = c.req.param('code');
      const body = await c.req.json().catch(() => ({}));

      const [row] = await db
        .select()
        .from(tunnelDeviceAuthRequests)
        .where(
          and(
            eq(tunnelDeviceAuthRequests.deviceCode, code),
            eq(tunnelDeviceAuthRequests.status, 'pending'),
            gt(tunnelDeviceAuthRequests.expiresAt, new Date()),
          ),
        );

      if (!row) {
        return c.json({ error: 'Device auth request not found or expired' }, 404);
      }

      const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
      const name = requestedName || row.machineHostname || 'Unnamed';
      if (name.length > 255) return c.json({ error: 'name is too long (max 255)' }, 400);
      const requestedCapabilities = body.capabilities ?? [];
      if (
        !Array.isArray(requestedCapabilities) ||
        !requestedCapabilities.every((capability) => typeof capability === 'string')
      ) {
        return c.json({ error: 'capabilities must be an array of strings' }, 400);
      }
      const capabilities = [...new Set(requestedCapabilities as string[])];
      if (
        capabilities.length !== requestedCapabilities.length ||
        capabilities.some((capability) => !isValidCapability(capability))
      ) {
        return c.json({ error: 'capabilities must contain unique supported capabilities' }, 400);
      }

      // The setup token is derived and returned only during the short device
      // handoff window. Its plaintext is never persisted in Postgres.
      const setupToken = deriveDeviceSetupToken(row.deviceSecretHash, row.id);
      const setupTokenHash = hashSecretKey(setupToken);
      const connection = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(tunnelDeviceAuthRequests)
          .set({ status: 'approved', accountId, updatedAt: new Date() })
          .where(
            and(
              eq(tunnelDeviceAuthRequests.id, row.id),
              eq(tunnelDeviceAuthRequests.status, 'pending'),
              gt(tunnelDeviceAuthRequests.expiresAt, new Date()),
            ),
          )
          .returning({ id: tunnelDeviceAuthRequests.id });
        if (!claimed) return null;

        const [created] = await tx
          .insert(tunnelConnections)
          .values({
            accountId,
            name,
            capabilities,
            status: 'offline',
            setupTokenHash,
          })
          .returning();
        if (!created) throw new Error('Tunnel connection insert returned no row');

        if (capabilities.length > 0) {
          const grants = capabilities.flatMap((cap) => {
            const scopes = DEFAULT_PERMISSION_SCOPES[cap] ?? [];
            return scopes.map((scope) => ({
              tunnelId: created.tunnelId,
              accountId,
              capability: cap as 'filesystem' | 'shell' | 'desktop',
              scope,
              status: 'active' as const,
            }));
          });
          if (grants.length > 0) await tx.insert(tunnelPermissions).values(grants);
        }

        await tx
          .update(tunnelDeviceAuthRequests)
          .set({
            tunnelId: created.tunnelId,
            setupToken: null,
            updatedAt: new Date(),
          })
          .where(eq(tunnelDeviceAuthRequests.id, row.id));
        return created;
      });

      if (!connection) {
        return c.json({ error: 'Device auth request was already resolved' }, 409);
      }

      // The WS handshake materializes this machine profile after it proves a
      // real connection. This reconcile also repairs previously-connected rows.
      void reconcileComputerConnectors(accountId);

      return c.json({ success: true, tunnelId: connection.tunnelId });
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
      requireUserCredential(c);
      const rl = checkDeviceAuthResolutionRateLimit(c, 'deviceAuthDeny');
      if (!rl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
      }
      const code = c.req.param('code');

      const [updated] = await db
        .update(tunnelDeviceAuthRequests)
        .set({ status: 'denied', updatedAt: new Date() })
        .where(
          and(
            eq(tunnelDeviceAuthRequests.deviceCode, code),
            eq(tunnelDeviceAuthRequests.status, 'pending'),
          ),
        )
        .returning();

      if (!updated) {
        return c.json({ error: 'Device auth request not found or already resolved' }, 404);
      }

      return c.json({ success: true });
    },
  );

  return router;
}
