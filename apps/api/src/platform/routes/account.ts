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
import { eq, and, desc, ne } from 'drizzle-orm';
import { sandboxes, type Database } from '@kortix/db';
import { db as defaultDb } from '../../shared/db';
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
import { registerCreator as ensureSandboxCreatorMember } from '../../teams';

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

async function adoptRunningLocalSandbox(
  db: Database,
  accountId: string,
  userId: string,
): Promise<{ row: typeof sandboxes.$inferSelect; created: boolean } | null> {
  const { LocalDockerProvider } = await import('../providers/local-docker');
  const provider = new LocalDockerProvider();
  const existing = await provider.find();

  if (!existing || existing.status !== 'running') {
    return null;
  }

  const metadata = {
    containerName: existing.name,
    containerId: existing.containerId,
    image: existing.image,
    mappedPorts: existing.mappedPorts,
    manualLocal: true,
  };

  const [existingRow] = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.accountId, accountId),
        eq(sandboxes.provider, 'local_docker'),
        ne(sandboxes.status, 'archived'),
      ),
    )
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);

  let row: typeof sandboxes.$inferSelect | undefined;
  if (existingRow) {
    [row] = await db
      .update(sandboxes)
      .set({
        externalId: existing.name,
        baseUrl: existing.baseUrl,
        status: 'active',
        metadata: {
          ...(existingRow.metadata as Record<string, unknown> | null ?? {}),
          ...metadata,
        },
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.sandboxId, existingRow.sandboxId))
      .returning();
  } else {
    [row] = await db
      .insert(sandboxes)
      .values({
        accountId,
        name: 'Local Sandbox',
        provider: 'local_docker',
        externalId: existing.name,
        status: 'active',
        baseUrl: existing.baseUrl,
        config: {},
        metadata,
      })
      .returning();
  }

  if (!row) {
    throw new Error('Failed to persist local sandbox state');
  }

  await ensureSandboxCreatorMember(db, row.sandboxId, userId);
  return { row, created: !existingRow };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createAccountRouter(
  overrides: Partial<AccountRouterDeps> = {},
): Hono<{ Variables: AuthVariables }> {
  const deps = { ...defaultDeps, ...overrides };
  const { db, getDefaultProviderName, getAvailableProviders, resolveAccountId } = deps;

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

      if (targetProvider === 'local_docker') {
        if (!config.isLocalDockerEnabled()) {
          return c.json({ success: false, error: 'Local Docker provider is not enabled' }, 403);
        }

        const adopted = await adoptRunningLocalSandbox(db, accountId, userId);
        if (!adopted) {
          return c.json({
            success: false,
            status: 'not_running',
            code: 'LOCAL_SANDBOX_NOT_RUNNING',
            error: 'Local sandbox is not running. Start it manually with `pnpm dev:sandbox`, then try again.',
          }, 409);
        }

        console.log(`[PLATFORM] Adopted manually-started local sandbox ${adopted.row.sandboxId} for account ${accountId}`);
        return c.json(
          { success: true, data: serializeSandbox(adopted.row), created: adopted.created },
          adopted.created ? 201 : 200,
        );
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
  // Manual-only local Docker adoption. The API must never pull, create, start,
  // or recreate `kortix-sandbox`; operators start it explicitly with
  // `pnpm dev:sandbox` / docker compose, then this route records the running
  // container in the DB for the signed-in user.

  router.post('/init/local', async (c) => {
    if (!config.isLocalDockerEnabled()) {
      return c.json({ success: false, error: 'Local Docker provider is not enabled' }, 403);
    }

    const userId = c.get('userId');

    try {
      const accountId = await resolveAccountId(userId);
      const adopted = await adoptRunningLocalSandbox(db, accountId, userId);

      if (!adopted) {
        return c.json({
          success: false,
          status: 'not_running',
          code: 'LOCAL_SANDBOX_NOT_RUNNING',
          error: 'Local sandbox is not running. Start it manually with `pnpm dev:sandbox`, then try again.',
        }, 409);
      }

      console.log(`[PLATFORM] Adopted manually-started local sandbox ${adopted.row.sandboxId} for account ${accountId}`);
      return c.json({ success: true, data: serializeSandbox(adopted.row), status: 'ready' }, adopted.created ? 201 : 200);
    } catch (err) {
      console.error('[PLATFORM] init/local error:', err);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, error: `Failed to adopt local sandbox: ${message}` }, 500);
    }
  });

  // ─── GET /init/local/status ───────────────────────────────────────────
  // Manual-only local status probe. This endpoint only inspects the container;
  // it never pulls, creates, starts, or mutates DB state.

  router.get('/init/local/status', async (c) => {
    if (!config.isLocalDockerEnabled()) {
      return c.json({ success: false, error: 'Local Docker provider is not enabled' }, 403);
    }

    try {
      const { LocalDockerProvider } = await import('../providers/local-docker');
      const provider = new LocalDockerProvider();
      const existing = await provider.find();

      if (!existing || existing.status !== 'running') {
        return c.json({
          success: true,
          status: 'none',
          message: 'Local sandbox is not running. Start it manually with `pnpm dev:sandbox`.',
        });
      }

      const healthUrl = config.SANDBOX_NETWORK
        ? `http://${config.SANDBOX_CONTAINER_NAME}:8000/kortix/health`
        : `http://localhost:${config.SANDBOX_PORT_BASE || 14000}/kortix/health`;

      try {
        const health = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
        if (health.ok) {
          const payload = await health.json() as { status?: string; runtimeReady?: boolean };
          if (payload.status === 'ok' && payload.runtimeReady === true) {
            return c.json({ success: true, status: 'ready', message: 'Local sandbox is running' });
          }
        }
      } catch {
        // Container is running but health endpoint is still warming up.
      }

      return c.json({
        success: true,
        status: 'creating',
        progress: 95,
        message: 'Local sandbox container is running and finishing Kortix boot...',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return router;
}

// ─── Default instance ────────────────────────────────────────────────────────
export const accountRouter = createAccountRouter();
