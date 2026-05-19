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

import { Hono } from 'hono';
import { eq, and, gt } from 'drizzle-orm';
import { tunnelConnections, tunnelDeviceAuthRequests, tunnelPermissions } from '@kortix/db';
import { db } from '../../shared/db';
import { generateDeviceCode, generateTunnelToken, hashSecretKey, verifySecretKey, randomAlphanumeric } from '../../shared/crypto';
import { tunnelRateLimiter } from '../core/rate-limiter';
import { resolveAccountId } from '../../shared/resolve-account';
import { config } from '../../config';
import { requireUserCredential } from './auth';

const DEVICE_AUTH_TTL_MS = 5 * 60_000;

/**
 * Public router — mounted BEFORE auth middleware.
 * Handles create + poll (unauthenticated, used by CLI).
 */
export function createDeviceAuthPublicRouter(): Hono {
  const router = new Hono();

  // POST / — create device auth request
  router.post('/', async (c) => {
    const ip = 'public-device-auth-create';
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

    // Generate code + secret
    const deviceCode = generateDeviceCode();
    const deviceSecret = randomAlphanumeric(32);
    const deviceSecretHash = hashSecretKey(deviceSecret);
    const expiresAt = new Date(Date.now() + DEVICE_AUTH_TTL_MS);

    await db.insert(tunnelDeviceAuthRequests).values({
      deviceCode,
      deviceSecretHash,
      machineHostname,
      expiresAt,
    });

    const appUrl = config.FRONTEND_URL || 'http://localhost:3000';

    return c.json({
      deviceCode,
      deviceSecret,
      verificationUrl: `${appUrl}/tunnel/authorize/${deviceCode}`,
      expiresAt: expiresAt.toISOString(),
      pollIntervalMs: 2000,
    }, 201);
  });

  // GET /:code/status — poll for approval
  router.get('/:code/status', async (c) => {
    const code = c.req.param('code');
    const authHeader = c.req.header('Authorization');
    const secret = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;

    if (!secret) {
      return c.json({ error: 'device auth secret required' }, 400);
    }

    const rl = tunnelRateLimiter.check('deviceAuthPoll', code);
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

    // Check expiry
    if (row.expiresAt < new Date()) {
      return c.json({ status: 'expired' });
    }

    if (row.status === 'denied') {
      return c.json({ status: 'denied' });
    }

    if (row.status === 'approved' && row.tunnelId && row.setupToken) {
      const token = row.setupToken;

      // NULL out the token after returning it once
      db.update(tunnelDeviceAuthRequests)
        .set({ setupToken: null, updatedAt: new Date() })
        .where(eq(tunnelDeviceAuthRequests.id, row.id))
        .catch(() => {});

      return c.json({
        status: 'approved',
        tunnelId: row.tunnelId,
        token,
      });
    }

    return c.json({ status: 'pending' });
  });

  return router;
}

/**
 * Authenticated router — mounted inside tunnelApp (behind combinedAuth).
 * Handles info, approve, deny.
 */
export function createDeviceAuthRouter(): Hono {
  const router = new Hono();

  // GET /:code/info — fetch request details for approval page
  router.get('/:code/info', async (c: any) => {
    requireUserCredential(c);
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
  });

  // POST /:code/approve — approve and create tunnel + token
  router.post('/:code/approve', async (c: any) => {
    requireUserCredential(c);
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
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

    const name = (body.name as string) || row.machineHostname || 'Unnamed';
    const capabilities = (body.capabilities as string[]) || [];

    // Create tunnel connection (same as POST /connections)
    const setupToken = generateTunnelToken();
    const setupTokenHash = hashSecretKey(setupToken);

    const [connection] = await db
      .insert(tunnelConnections)
      .values({
        accountId,
        name,
        capabilities,
        status: 'offline',
        setupTokenHash,
      })
      .returning();

    // Grant permissions for each selected capability
    if (capabilities.length > 0) {
      await db.insert(tunnelPermissions).values(
        capabilities.map((cap: string) => ({
          tunnelId: connection.tunnelId,
          accountId,
          capability: cap as any,
          scope: {},
          status: 'active' as const,
        })),
      );
    }

    // Update device auth row with approval + token
    await db
      .update(tunnelDeviceAuthRequests)
      .set({
        status: 'approved',
        accountId,
        tunnelId: connection.tunnelId,
        setupToken,
        updatedAt: new Date(),
      })
      .where(eq(tunnelDeviceAuthRequests.id, row.id));

    return c.json({ success: true, tunnelId: connection.tunnelId });
  });

  // POST /:code/deny — deny request
  router.post('/:code/deny', async (c: any) => {
    requireUserCredential(c);
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
  });

  return router;
}
