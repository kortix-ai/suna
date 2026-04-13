/**
 * Cloud-mode account router.
 *
 * Handles user account initialization and provider listing.
 * Sandbox lifecycle has been moved to sandbox-cloud.ts.
 *
 * Routes (mounted at /v1/platform):
 *   GET  /providers  — List available sandbox providers
 *   POST /init       — Ensure user has an account, provision sandbox if needed
 */

import { Hono } from 'hono';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { sandboxes, type Database } from '@kortix/db';
import { db as defaultDb } from '../../shared/db';
import { createApiKey } from '../../repositories/api-keys';
import { supabaseAuth as authMiddleware } from '../../middleware/auth';
import {
  getProvider as defaultGetProvider,
  getDefaultProviderName as defaultGetDefaultProviderName,
  getAvailableProviders as defaultGetAvailableProviders,
  type ProviderName,
  type SandboxProvider,
} from '../providers';
import type { AuthVariables } from '../../types';
import { resolveAccountId as defaultResolveAccountId } from '../../shared/resolve-account';
import { config } from '../../config';
import { generateSandboxName } from '../services/ensure-sandbox';

// ─── Dependency Injection ────────────────────────────────────────────────────

export interface AccountRouterDeps {
  db: Database;
  getProvider: (name: ProviderName) => SandboxProvider;
  getDefaultProviderName: () => ProviderName;
  getAvailableProviders: () => ProviderName[];
  resolveAccountId: (userId: string) => Promise<string>;
  useAuth: boolean;
}

const defaultDeps: AccountRouterDeps = {
  db: defaultDb,
  getProvider: defaultGetProvider,
  getDefaultProviderName: defaultGetDefaultProviderName,
  getAvailableProviders: defaultGetAvailableProviders,
  resolveAccountId: defaultResolveAccountId,
  useAuth: true,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serializeSandbox(row: typeof sandboxes.$inferSelect) {
  const metadata = row.metadata as Record<string, unknown> | null;
  const cancelAtPeriodEnd = Boolean((metadata?.cancel_at_period_end as boolean) ?? false);
  const cancelAt = (metadata?.cancel_at as string) ?? null;
  return {
    sandbox_id: row.sandboxId,
    external_id: row.externalId,
    name: row.name,
    provider: row.provider,
    base_url: row.baseUrl,
    status: row.status,
    version: metadata?.version ?? null,
    metadata: row.metadata,
    is_included: false,
    stripe_subscription_id: (metadata?.stripe_subscription_id as string) ?? null,
    stripe_subscription_item_id: row.stripeSubscriptionItemId ?? null,
    cancel_at_period_end: cancelAtPeriodEnd,
    cancel_at: cancelAt,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createAccountRouter(
  overrides: Partial<AccountRouterDeps> = {},
): Hono<{ Variables: AuthVariables }> {
  const deps = { ...defaultDeps, ...overrides };
  const { db, getProvider, getDefaultProviderName, getAvailableProviders, resolveAccountId } = deps;

  const router = new Hono<{ Variables: AuthVariables }>();

  if (deps.useAuth) {
    router.use('/*', authMiddleware);
  }

  // ─── GET /providers ────────────────────────────────────────────────────

  router.get('/providers', async (c) => {
    return c.json({
      success: true,
      data: {
        providers: getAvailableProviders(),
        default: getDefaultProviderName(),
      },
    });
  });

  // ─── POST /init ────────────────────────────────────────────────────────
  // Ensure user has an account + sandbox.

  router.post('/init', async (c) => {
    const userId = c.get('userId');

    try {
      const body = await c.req.json().catch(() => ({}));
      const requestedProvider = (body?.provider as ProviderName) || undefined;
      const requestedServerType = (body?.serverType as string | undefined) || undefined;

      const accountId = await resolveAccountId(userId);

      // In cloud billing mode, managed VPS provisioning is paid-only.
      // Free/new accounts must complete billing setup first (or connect custom instance).
      const targetProvider = requestedProvider || getDefaultProviderName();
      if (config.KORTIX_BILLING_INTERNAL_ENABLED && targetProvider === 'justavps') {
        const [{ getCreditAccount }, { isPaidTier }] = await Promise.all([
          import('../../billing/repositories/credit-accounts'),
          import('../../billing/services/tiers'),
        ]);

        const account = await getCreditAccount(accountId);
        const tier = account?.tier ?? 'none';
        if (!isPaidTier(tier)) {
          return c.json(
            {
              success: false,
              error: 'Managed cloud sandbox requires Pro plan. Complete plan setup first.',
              code: 'PLAN_REQUIRED',
            },
            402,
          );
        }
      }

      const { ensureSandbox } = await import('../services/ensure-sandbox');
      const { row, created } = await ensureSandbox({
        accountId,
        userId,
        provider: requestedProvider,
        serverType: requestedServerType,
      });

      return c.json(
        { success: true, data: serializeSandbox(row), created },
        created ? 201 : 200,
      );
    } catch (err) {
      console.error('[PLATFORM] initAccount error:', err);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, error: `Failed to initialize account: ${message}` }, 500);
    }
  });

  // ─── POST /init/local ──────────────────────────────────────────────────
  // Local Docker sandbox init with async image pull + progress polling.
  // Returns immediately with { status: 'pulling', progress: 0 } if image
  // is missing, or creates the sandbox synchronously if image exists.
  // Frontend polls GET /init/local/status for pull progress.

  router.post('/init/local', async (c) => {
    if (!config.isLocalDockerEnabled()) {
      return c.json({ success: false, error: 'Local Docker provider is not enabled' }, 403);
    }

    const userId = c.get('userId');

    try {
      const accountId = await resolveAccountId(userId);

      // If there's already an active sandbox, return it
      const [active] = await db
        .select()
        .from(sandboxes)
        .where(
          and(
            eq(sandboxes.accountId, accountId),
            eq(sandboxes.provider, 'local_docker'),
            eq(sandboxes.status, 'active'),
          ),
        )
        .limit(1);

      if (active) {
        return c.json({ success: true, data: serializeSandbox(active), status: 'ready' });
      }

      // Check if a provisioning sandbox already exists (pull in progress)
      const [provisioning] = await db
        .select()
        .from(sandboxes)
        .where(
          and(
            eq(sandboxes.accountId, accountId),
            eq(sandboxes.provider, 'local_docker'),
            eq(sandboxes.status, 'provisioning'),
          ),
        )
        .limit(1);

      if (provisioning) {
        const { getImagePullStatus, LocalDockerProvider } = await import('../providers/local-docker');
        const pullStatus = getImagePullStatus();

        // Stale provisioning row: nothing is actually pulling (e.g. server restarted
        // or previous attempt failed). Check if the container is already running
        // (the pull + create may have succeeded before the restart). If so, heal
        // the row to 'active'. Otherwise mark as error and re-provision.
        if (pullStatus.state === 'idle' || pullStatus.state === 'error') {
          // Check if container is already running (auto-heal)
          try {
            const dockerProvider = new LocalDockerProvider();
            const existing = await dockerProvider.find();
            if (existing && existing.status === 'running') {
              console.log(`[PLATFORM] Auto-healing stale provisioning row ${provisioning.sandboxId} — container is running`);
              const [healed] = await db
                .update(sandboxes)
                .set({
                  externalId: existing.name,
                  baseUrl: existing.baseUrl,
                  status: 'active',
                  metadata: {
                    containerName: existing.name,
                    containerId: existing.containerId,
                    image: existing.image,
                    mappedPorts: existing.mappedPorts,
                  },
                  updatedAt: new Date(),
                })
                .where(eq(sandboxes.sandboxId, provisioning.sandboxId))
                .returning();
              if (healed) {
                return c.json({ success: true, data: serializeSandbox(healed), status: 'ready' });
              }
            }
          } catch (healErr) {
            console.warn(`[PLATFORM] Auto-heal check failed:`, healErr);
          }

          console.warn(`[PLATFORM] Stale provisioning row ${provisioning.sandboxId} with pull state '${pullStatus.state}', cleaning up...`);
          await db
            .update(sandboxes)
            .set({ status: 'error', updatedAt: new Date() })
            .where(eq(sandboxes.sandboxId, provisioning.sandboxId));
          // Fall through to provision fresh below
        } else {
          return c.json({
            success: true,
            status: pullStatus.state === 'done' ? 'creating' : 'pulling',
            progress: pullStatus.progress,
            message: pullStatus.message,
          });
        }
      }

      // Check if image exists locally
      const provider = getProvider('local_docker' as ProviderName);
      const { LocalDockerProvider } = await import('../providers/local-docker');
      if (!(provider instanceof LocalDockerProvider)) {
        return c.json({ success: false, error: 'local_docker provider not available' }, 400);
      }

      const hasImage = await provider.hasImage();
      const sandboxName = await generateSandboxName(accountId);

      if (hasImage) {
        // Image exists — create sandbox row first, then provision
        const [sandbox] = await db
          .insert(sandboxes)
          .values({
            accountId,
            name: sandboxName,
            provider: 'local_docker',
            externalId: '',
            status: 'provisioning',
            baseUrl: '',
            config: {},
            metadata: {},
          })
          .returning();

        // Create sandbox-managed API key
        const sandboxKey = await createApiKey({
          sandboxId: sandbox.sandboxId,
          accountId,
          title: 'Sandbox Token',
          type: 'sandbox',
        });

        let result: Awaited<ReturnType<typeof provider.create>> | null = null;
        let racedWithExistingContainer = false;
        try {
          result = await provider.create({
            accountId,
            userId,
            name: sandboxName,
            envVars: { KORTIX_TOKEN: sandboxKey.secretKey },
          });
        } catch (createErr) {
          const message = createErr instanceof Error ? createErr.message : String(createErr);
          if (!message.includes('already in use')) throw createErr;

          console.warn(`[PLATFORM] Local sandbox create raced with an existing container; returning creating state and letting status polling heal it.`);
          racedWithExistingContainer = true;
        }

        if (racedWithExistingContainer) {
          return c.json({
            success: true,
            status: 'creating',
            progress: 95,
            message: 'Sandbox container already exists, waiting for it to become ready…',
          }, 202);
        }

        const [updated] = await db
          .update(sandboxes)
          .set({
            externalId: result!.externalId,
            status: 'active',
            baseUrl: result!.baseUrl,
            metadata: result!.metadata,
            updatedAt: new Date(),
          })
          .where(eq(sandboxes.sandboxId, sandbox.sandboxId))
          .returning();

        if (!updated) {
          return c.json({ success: false, error: 'Failed to persist sandbox state' }, 500);
        }

        console.log(`[PLATFORM] Local sandbox ${sandbox.sandboxId} created for account ${accountId}`);
        return c.json({ success: true, data: serializeSandbox(updated), status: 'ready' }, 201);
      }

      // Image missing — insert provisioning row and pull in background
      const [placeholder] = await db
        .insert(sandboxes)
        .values({
          accountId,
          name: sandboxName,
          provider: 'local_docker',
          externalId: '',
          status: 'provisioning',
          baseUrl: '',
          config: {},
          metadata: {},
        })
        .returning();

      // Create sandbox-managed API key (before background pull so it's ready)
      const sandboxKey = await createApiKey({
        sandboxId: placeholder.sandboxId,
        accountId,
        title: 'Sandbox Token',
        type: 'sandbox',
      });

      console.log(`[PLATFORM] Starting image pull for account ${accountId}...`);

      // Background: pull image → create container → update DB row
      (async () => {
        try {
          await provider.pullImage();

          const result = await provider.create({
            accountId,
            userId,
            name: sandboxName,
            envVars: { KORTIX_TOKEN: sandboxKey.secretKey },
          });

          await db
            .update(sandboxes)
            .set({
              externalId: result.externalId,
              baseUrl: result.baseUrl,
              status: 'active',
              metadata: result.metadata,
              updatedAt: new Date(),
            })
            .where(eq(sandboxes.sandboxId, placeholder.sandboxId));

          console.log(`[PLATFORM] Local sandbox ${placeholder.sandboxId} provisioned after image pull`);
        } catch (err) {
          console.error(`[PLATFORM] Background provisioning failed:`, err);
          await db
            .update(sandboxes)
            .set({ status: 'error', updatedAt: new Date() })
            .where(eq(sandboxes.sandboxId, placeholder.sandboxId));
        }
      })();

      return c.json({
        success: true,
        status: 'pulling',
        progress: 0,
        message: 'Pulling sandbox image... this may take a few minutes',
      }, 202);
    } catch (err) {
      console.error('[PLATFORM] init/local error:', err);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, error: `Failed to initialize local sandbox: ${message}` }, 500);
    }
  });

  // ─── GET /init/local/status ───────────────────────────────────────────
  // Poll endpoint for local sandbox provisioning progress.

  router.get('/init/local/status', async (c) => {
    if (!config.isLocalDockerEnabled()) {
      return c.json({ success: false, error: 'Local Docker provider is not enabled' }, 403);
    }

    const userId = c.get('userId');

    try {
      const accountId = await resolveAccountId(userId);

      const [row] = await db
        .select()
        .from(sandboxes)
        .where(
          and(
            eq(sandboxes.accountId, accountId),
            eq(sandboxes.provider, 'local_docker'),
          ),
        )
        .orderBy(desc(sandboxes.createdAt))
        .limit(1);

      if (!row) {
        return c.json({ success: true, status: 'none', message: 'No sandbox found' });
      }

      if (row.status === 'active') {
        return c.json({ success: true, status: 'ready', data: serializeSandbox(row) });
      }

      if (row.status === 'provisioning') {
        const { getImagePullStatus, LocalDockerProvider } = await import('../providers/local-docker');
        const pullStatus = getImagePullStatus();

        // Auto-heal: if in-memory pull state is idle (e.g. server restarted after
        // the pull + container creation succeeded), check if the container is
        // actually running. If so, transition the DB row to 'active'.
        if (pullStatus.state === 'idle' || pullStatus.state === 'done') {
          try {
            const provider = new LocalDockerProvider();
            const existing = await provider.find();
            if (existing && existing.status === 'running') {
              console.log(`[PLATFORM] Auto-healing stale provisioning row ${row.sandboxId} — container is running`);
              const [healed] = await db
                .update(sandboxes)
                .set({
                  externalId: existing.name,
                  baseUrl: existing.baseUrl,
                  status: 'active',
                  metadata: {
                    containerName: existing.name,
                    containerId: existing.containerId,
                    image: existing.image,
                    mappedPorts: existing.mappedPorts,
                  },
                  updatedAt: new Date(),
                })
                .where(eq(sandboxes.sandboxId, row.sandboxId))
                .returning();
              if (healed) {
                return c.json({ success: true, status: 'ready', data: serializeSandbox(healed) });
              }
            }
          } catch (healErr) {
            console.warn(`[PLATFORM] Auto-heal check failed:`, healErr);
          }
        }

        return c.json({
          success: true,
          status: pullStatus.state === 'error' ? 'error' : 'pulling',
          progress: pullStatus.progress,
          message: pullStatus.message,
          error: pullStatus.error,
        });
      }

      if (row.status === 'error') {
        return c.json({ success: true, status: 'error', message: 'Sandbox provisioning failed' });
      }

      return c.json({ success: true, status: row.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return router;
}

// ─── Default instance ────────────────────────────────────────────────────────
export const accountRouter = createAccountRouter();
