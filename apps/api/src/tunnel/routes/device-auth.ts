/**
 * Device Auth Routes — browser-based authorization for tunnel connections.
 *
 * Public (no auth):
 *   POST   /                     — create device auth request (CLI calls this)
 *   GET    /:code/status         — poll for approval (CLI polls this)
 *
 * Authenticated:
 *   GET    /device-auth/:code/info    — fetch request details (browser approval page)
 *   POST   /device-auth/:code/approve — approve: pair the machine to the approver
 *                                       (optionally sharing it with one project)
 *   POST   /device-auth/:code/deny    — deny request
 */

import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { requestClientKey } from '../../middleware/client-ip';
import { createHash } from 'node:crypto';
import { eq, and, desc, gt, sql } from 'drizzle-orm';
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
import { getTunnelReadContext, requireUserCredential } from './auth';
import { isValidCapability } from '../core/scope-validator';
import { ensureComputerConnector } from '../../connectors/sync';
import { attachComputerConnection } from '../../connectors/computers';
import { PROJECT_ACTIONS } from '../../iam';
import { loadProjectForUser, projectCapabilityAllowed } from '../../projects/lib/access';
import { parseConnectorConnectOwner } from '../../projects/lib/connection-access';
import { readJsonObject } from '../../shared/http-body';
import { isUuid } from '../../shared/validate';
import { tunnelRelay } from '../core/relay';
import { isTunnelConnectionLive } from '../core/cluster-forwarder';
import { retireSupersededRegistrations } from '../registrations';
import { bearerToken } from '../../shared/bearer-token';

const DEVICE_AUTH_TTL_MS = 5 * 60_000;
/**
 * Wire permissions minted at pairing: one full-scope grant per approved
 * capability. Installed agents (npm `@kortix/agent-tunnel@0.1.x`) require a
 * synced `permissionId` on every RPC, so these stay; they are not a product
 * surface. The agent's local config remains the hard ceiling.
 */
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

/** One machine, one registration: the approver's own pairing of this hardware. */
function registeredMachine(userId: string, machineId: string) {
  return and(
    eq(tunnelConnections.ownerUserId, userId),
    sql`${tunnelConnections.machineInfo}->>'machineId' = ${machineId}`,
  );
}

function devicePollRateLimitKey(c: any, secret: string): string {
  const secretId = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  return `${requestClientKey(c)}:${secretId}`;
}

function checkDeviceAuthResolutionRateLimit(c: any, endpoint: string) {
  const userId = (c.get('userId') as string | undefined) ?? 'anonymous';
  const key = `${userId}:${requestClientKey(c)}`;
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
              schema: z.object({
                machineHostname: z.string().optional(),
                /** sha256 hex of the machine's hardware id. Approval reuses the
                 *  approver's existing registration of this machine. */
                machine_id: z.string().optional(),
                /** The project the machine asks to join (`connect --project-id`). */
                project_id: z.string().uuid().optional(),
              }),
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
        ...errors(400, 429),
      },
    }),
    async (c: any) => {
      const ip = requestClientKey(c);
      const globalRl = tunnelRateLimiter.check('deviceAuthCreateGlobal', 'global');
      if (!globalRl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: globalRl.retryAfterMs }, 429);
      }
      const rl = tunnelRateLimiter.check('deviceAuthCreate', ip);
      if (!rl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
      }

      const body = await readJsonObject(c);
      const machineHostname =
        typeof body.machineHostname === 'string' ? body.machineHostname.slice(0, 255) || null : null;
      // An older agent sends no machine id; anything but a sha256 hex is dropped.
      const machineId =
        typeof body.machine_id === 'string' && /^[a-f0-9]{64}$/.test(body.machine_id)
          ? body.machine_id
          : null;
      // Untrusted hint from an unauthenticated machine: stored as-is, and
      // checked against the approver's project access at approval.
      const projectId = body.project_id ?? null;
      if (projectId !== null && !isUuid(projectId)) {
        return c.json({ error: 'project_id must be a UUID' }, 400);
      }

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
            machineId,
            projectId,
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
      const bearerSecret = bearerToken(authHeader) ?? undefined;
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

  registerDeviceAuthInfoRoute(router);
  registerDeviceAuthApproveRoute(router);
  registerDeviceAuthDenyRoute(router);

  return router;
}

function registerDeviceAuthInfoRoute(router: OpenAPIHono<AppEnv>): void {
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
          machineId: tunnelDeviceAuthRequests.machineId,
          projectId: tunnelDeviceAuthRequests.projectId,
          status: tunnelDeviceAuthRequests.status,
          expiresAt: tunnelDeviceAuthRequests.expiresAt,
          createdAt: tunnelDeviceAuthRequests.createdAt,
        })
        .from(tunnelDeviceAuthRequests)
        .where(eq(tunnelDeviceAuthRequests.deviceCode, code));

      if (!row) {
        return c.json({ error: 'Device auth request not found' }, 404);
      }

      // The approval page says "already connected" and prefills the name and
      // grants. The hardware id itself never leaves the server.
      const { machineId, ...request } = row;
      const userId = c.get('userId') as string | undefined;
      const [machine] =
        machineId && userId
          ? await db
              .select({
                tunnelId: tunnelConnections.tunnelId,
                name: tunnelConnections.name,
                capabilities: tunnelConnections.capabilities,
                status: tunnelConnections.status,
                lastHeartbeatAt: tunnelConnections.lastHeartbeatAt,
                relayOwnerId: tunnelConnections.relayOwnerId,
                relayOwnerHeartbeatAt: tunnelConnections.relayOwnerHeartbeatAt,
              })
              .from(tunnelConnections)
              .where(registeredMachine(userId, machineId))
              .orderBy(desc(tunnelConnections.createdAt))
              .limit(1)
          : [];
      const registered = machine
        ? {
            tunnelId: machine.tunnelId,
            name: machine.name,
            capabilities: machine.capabilities,
            isLive: isTunnelConnectionLive(machine),
          }
        : null;

      if (request.expiresAt < new Date() && request.status === 'pending') {
        return c.json({ ...request, status: 'expired', registered });
      }

      return c.json({ ...request, registered });
    },
  );
}

function registerDeviceAuthApproveRoute(router: OpenAPIHono<AppEnv>): void {
  // POST /:code/approve — pair the machine + add it to a project as an account
  router.openapi(
    createRoute({
      method: 'post',
      path: '/{code}/approve',
      tags: ['tunnel'],
      summary: 'Approve a device-auth request (pairs the machine to the caller)',
      description:
        'Creates, in one transaction, the paired machine (owned by the caller) and its wire permissions. The machine becomes the caller\'s private account in every project they open (no project needed). With a project (`project_id`, or the one the machine sent), the account is created there at once: private (`share: "me"`, default) or shared with the project (`share: "project"`, needs the connector-connections manage capability and a project).',
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
                /** Optional: a project to add the machine to now. Required for `share: "project"`. */
                project_id: z.string().uuid().optional(),
                share: z.enum(['me', 'project']).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(
          z.object({
            success: z.boolean(),
            tunnelId: z.string(),
            /** The computer account in the project; null when approved without one. */
            connectionId: z.string().nullable(),
          }),
          'The paired machine and its computer account',
        ),
        ...errors(400, 401, 403, 404, 409, 429),
      },
    }),
    async (c: any) => {
      requireUserCredential(c);
      const rl = checkDeviceAuthResolutionRateLimit(c, 'deviceAuthApprove');
      if (!rl.allowed) {
        return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
      }
      const code = c.req.param('code');
      const body = await readJsonObject(c);

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

      const requestedProject = body.project_id ?? body.projectId;
      const explicitProject = typeof requestedProject === 'string' && requestedProject ? requestedProject : null;
      const projectId = explicitProject ?? row.projectId;
      const share = parseConnectorConnectOwner(body.share);
      if (!share) return c.json({ error: "share must be 'me' or 'project'" }, 400);
      if (share === 'project' && !projectId) {
        return c.json({ error: 'project_id is required to share a computer with a project' }, 400);
      }
      if (projectId !== null && !isUuid(projectId)) {
        return c.json({ error: 'project_id must be a UUID' }, 400);
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

      // F3: the project the MACHINE named (unauthenticated) only offers "Also
      // share with". For "Only you" an unreadable one is ignored: the owner
      // reaches the computer from every project anyway (lazy ensure). The
      // approver's own choice, or a share with the project, must be readable.
      const loaded = projectId ? await loadProjectForUser(c, projectId, 'read') : null;
      const ignorable = share === 'me' && !explicitProject;
      if (projectId && !loaded && !ignorable) return c.json({ error: 'Project not found' }, 404);
      const context = loaded ? null : await getTunnelReadContext(c);
      const userId = (loaded?.userId ?? context?.userId) as string;
      const accountId = (loaded?.row.accountId ?? context?.accountId) as string;
      if (!userId) return c.json({ error: 'A user credential is required' }, 403);
      if (
        loaded &&
        share === 'project' &&
        !(await projectCapabilityAllowed(
          c,
          userId,
          accountId,
          loaded.row.projectId,
          PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
        ))
      ) {
        return c.json(
          {
            error: 'Sharing a computer with the project requires permission to manage its connections',
            code: 'FORBIDDEN',
          },
          403,
        );
      }

      // Idempotent and outside the transaction: the upsert owns its own
      // transaction. A computer connector without accounts is harmless.
      const connectorId = loaded
        ? await ensureComputerConnector(loaded.row.projectId, accountId)
        : null;

      // The setup token is derived and returned only during the short device
      // handoff window. Its plaintext is never persisted in Postgres.
      const setupToken = deriveDeviceSetupToken(row.deviceSecretHash, row.id);
      const setupTokenHash = hashSecretKey(setupToken);
      // A private machine lives in its owner's personal account (id = user id),
      // where it lived before contract v2: the previous API image shows a team
      // account's machines to every owner and admin through the raw /v1/tunnel
      // routes, so a rolling deploy or a rollback must not find a member's
      // laptop there. A machine shared with the project joins its account.
      const machineAccountId = share === 'project' ? accountId : userId;
      const paired = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(tunnelDeviceAuthRequests)
          .set({
            status: 'approved',
            accountId,
            projectId: loaded?.row.projectId ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tunnelDeviceAuthRequests.id, row.id),
              eq(tunnelDeviceAuthRequests.status, 'pending'),
              gt(tunnelDeviceAuthRequests.expiresAt, new Date()),
            ),
          )
          .returning({ id: tunnelDeviceAuthRequests.id });
        if (!claimed) return null;

        // One machine, one registration: a machine the approver already paired
        // (same hardware id) gets a new credential, name, and grants instead
        // of a second entry. Its accounts, shares, and bindings stay.
        const [registered] = row.machineId
          ? await tx
              .select({ tunnelId: tunnelConnections.tunnelId, accountId: tunnelConnections.accountId })
              .from(tunnelConnections)
              .where(registeredMachine(userId, row.machineId))
              .orderBy(desc(tunnelConnections.createdAt))
              .limit(1)
              .for('update')
          : [];
        if (registered) {
          await tx
            .update(tunnelConnections)
            .set({ name, capabilities, setupTokenHash, updatedAt: new Date() })
            .where(eq(tunnelConnections.tunnelId, registered.tunnelId));
          await tx.delete(tunnelPermissions).where(eq(tunnelPermissions.tunnelId, registered.tunnelId));
        }
        const [created] = registered
          ? [registered]
          : await tx
              .insert(tunnelConnections)
              .values({
                accountId: machineAccountId,
                ownerUserId: userId,
                name,
                capabilities,
                status: 'offline',
                setupTokenHash,
                machineInfo: row.machineId ? { machineId: row.machineId } : {},
              })
              .returning();
        if (!created) throw new Error('Tunnel connection insert returned no row');

        const grants = capabilities.flatMap((cap) =>
          (DEFAULT_PERMISSION_SCOPES[cap] ?? []).map((scope) => ({
            tunnelId: created.tunnelId,
            accountId: created.accountId,
            capability: cap as 'filesystem' | 'shell' | 'desktop',
            scope,
            status: 'active' as const,
          })),
        );
        if (grants.length > 0) await tx.insert(tunnelPermissions).values(grants);

        const attached =
          loaded && connectorId
            ? await attachComputerConnection(tx, {
                accountId,
                projectId: loaded.row.projectId,
                connectorId,
                ownerType: share === 'project' ? 'project' : 'member',
                ownerId: share === 'project' ? null : userId,
                tunnelId: created.tunnelId,
                name,
                createdBy: userId,
              })
            : null;

        await tx
          .update(tunnelDeviceAuthRequests)
          .set({
            tunnelId: created.tunnelId,
            setupToken: null,
            updatedAt: new Date(),
          })
          .where(eq(tunnelDeviceAuthRequests.id, row.id));
        return {
          tunnelId: created.tunnelId,
          connectionId: attached?.connection.connectionId ?? null,
          reused: Boolean(registered),
        };
      });

      if (!paired) {
        return c.json({ error: 'Device auth request was already resolved' }, 409);
      }
      const { reused, ...result } = paired;
      // The agent still running on the old credential yields to the new one.
      if (reused) tunnelRelay.disconnectAgent(result.tunnelId, 4003, 'setup token rotated');
      if (row.machineId) await retireSupersededRegistrations(result.tunnelId, row.machineId);

      return c.json({ success: true, ...result });
    },
  );
}

function registerDeviceAuthDenyRoute(router: OpenAPIHono<AppEnv>): void {
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
}
