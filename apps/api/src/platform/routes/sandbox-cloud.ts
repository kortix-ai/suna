/**
 * Sandbox router (DB-backed).
 *
 * DB-backed sandbox lifecycle. Mounted at /v1/platform/sandbox.
 *
 * Routes:
 *   GET    /          → Get the user's active sandbox (or 404)
 *   POST   /          → Ensure sandbox exists (idempotent create-or-return)
 *   GET    /list      → List all sandboxes for the account
 *   POST   /stop      → Stop the active sandbox
 *   POST   /restart   → Stop then start the active sandbox
 */

import { Hono } from 'hono';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { sandboxes, type Database } from '@kortix/db';
import { db as defaultDb } from '../../shared/db';
import { createApiKey } from '../../repositories/api-keys';
import { supabaseAuth as authMiddleware } from '../../middleware/auth';
import {
  getProvider as defaultGetProvider,
  getDefaultProviderName as defaultGetDefaultProviderName,
  type ProviderName,
  type SandboxProvider,
} from '../providers';
import { config } from '../../config';
import { justavpsFetch, listServerTypes as listJustAVPSServerTypes } from '../providers/justavps';
import type { AuthVariables } from '../../types';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { resolveAccountId as defaultResolveAccountId } from '../../shared/resolve-account';
import * as pool from '../../pool';
import { generateSandboxName } from '../services/ensure-sandbox';

// ─── Dependency Injection ────────────────────────────────────────────────────

export interface SandboxCloudRouterDeps {
  db: Database;
  getProvider: (name: ProviderName) => SandboxProvider;
  getDefaultProviderName: () => ProviderName;
  resolveAccountId: (userId: string) => Promise<string>;
  useAuth: boolean;
}

const defaultDeps: SandboxCloudRouterDeps = {
  db: defaultDb,
  getProvider: defaultGetProvider,
  getDefaultProviderName: defaultGetDefaultProviderName,
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

function isManagedVpsProvider(providerName: ProviderName): boolean {
  return providerName === 'justavps';
}

function getProviderDefaults() {
  return {
    location: config.JUSTAVPS_DEFAULT_LOCATION,
    serverType: config.JUSTAVPS_DEFAULT_SERVER_TYPE,
  };
}

function getProviderDisplayName(providerName: ProviderName): string {
  switch (providerName) {
    case 'justavps':
      return 'JustAVPS';
    case 'daytona':
      return 'Daytona';
    case 'local_docker':
      return 'Local Docker';
    default:
      return providerName;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createCloudSandboxRouter(
  overrides: Partial<SandboxCloudRouterDeps> = {},
): Hono<{ Variables: AuthVariables }> {
  const deps = { ...defaultDeps, ...overrides };
  const { db, getProvider, getDefaultProviderName, resolveAccountId } = deps;

  async function resolveSandboxAccess(userId: string) {
    const accountId = await resolveAccountId(userId);
    const admin = await isPlatformAdmin(accountId);
    return { accountId, isAdmin: admin };
  }

  async function findAccessibleSandbox(userId: string, sandboxId?: string, options: { defaultStatus?: string } = {}) {
    const access = await resolveSandboxAccess(userId);

    if (sandboxId) {
      const query = access.isAdmin
        ? and(eq(sandboxes.sandboxId, sandboxId), sql`${sandboxes.status} != 'archived'`)
        : and(eq(sandboxes.accountId, access.accountId), eq(sandboxes.sandboxId, sandboxId), sql`${sandboxes.status} != 'archived'`);
      const [sandbox] = await db.select().from(sandboxes).where(query).limit(1);
      return { access, sandbox: sandbox ?? null };
    }

    const clauses = [eq(sandboxes.accountId, access.accountId), sql`${sandboxes.status} != 'archived'`];
    if (options.defaultStatus) clauses.push(eq(sandboxes.status, options.defaultStatus as any));
    const [sandbox] = await db.select().from(sandboxes).where(and(...clauses)).orderBy(desc(sandboxes.createdAt)).limit(1);
    return { access, sandbox: sandbox ?? null };
  }

  const router = new Hono<{ Variables: AuthVariables }>();

  // ── Public routes (no auth required) ──

  router.get('/justavps/server-types', async (c) => {
    if (!config.isJustAVPSEnabled()) {
      return c.json({ error: 'JustAVPS provider is not enabled' }, 404);
    }
    try {
      const location = c.req.query('location') || config.JUSTAVPS_DEFAULT_LOCATION;
      const types = await listJustAVPSServerTypes(location);

      // Apply canonical display pricing from COMPUTE_TIERS so the API returns
      // the same prices the frontend shows and Stripe charges.  Raw provider
      // prices are kept in priceMonthly for internal use.
      const { COMPUTE_TIERS } = await import('../../billing/services/tiers');
      const withDisplayPricing = types.map((t) => {
        const tier = COMPUTE_TIERS[t.name];
        return tier
          ? { ...t, priceMonthlyMarkup: tier.priceUsd }
          : t;
      });

      return c.json({
        serverTypes: withDisplayPricing,
        location,
        defaultServerType: config.JUSTAVPS_DEFAULT_SERVER_TYPE,
        defaultLocation: config.JUSTAVPS_DEFAULT_LOCATION,
      });
    } catch (err: any) {
      console.error('[SANDBOX-CLOUD] justavps server-types error:', err);
      return c.json({ error: 'Failed to fetch server types' }, 500);
    }
  });

  // ── Auth-gated routes ──

  if (deps.useAuth) {
    router.use('/*', authMiddleware);
  }

  // ─── GET / ─────────────────────────────────────────────────────────────
  // Get the user's active sandbox. Returns 404 if none.

  router.get('/', async (c) => {
    const userId = c.get('userId');

    try {
      const accountId = await resolveAccountId(userId);

      // Return the best available sandbox: prefer active, then provisioning,
      // then stopped/error so the dashboard can show a recovery UI instead of
      // a blank 404 that leaves the user stuck.
      const [sandbox] = await db
        .select()
        .from(sandboxes)
        .where(
          and(
            eq(sandboxes.accountId, accountId),
            inArray(sandboxes.status, ['active', 'provisioning', 'stopped', 'error']),
          ),
        )
        .orderBy(
          sql`CASE status
            WHEN 'active'       THEN 0
            WHEN 'provisioning' THEN 1
            WHEN 'stopped'      THEN 2
            WHEN 'error'        THEN 3
            ELSE                     4
          END`
        )
        .limit(1);

      if (!sandbox) {
        return c.json(
          { success: false, error: 'No sandbox found. Call POST /v1/platform/sandbox to create one.' },
          404,
        );
      }

      return c.json({ success: true, data: serializeSandbox(sandbox) });
    } catch (err) {
      console.error('[SANDBOX-CLOUD] get error:', err);
      return c.json({ success: false, error: 'Failed to get sandbox' }, 500);
    }
  });

  // ─── POST / ────────────────────────────────────────────────────────────
  // Create a new sandbox. Managed VPS sandboxes are billed as 1 sandbox ↔ 1 Stripe subscription.

  router.post('/', async (c) => {
    const userId = c.get('userId');
    const userEmail = c.get('userEmail') as string | undefined;
    let stripeSubscriptionId: string | null = null;
    let stripeSubscriptionItemId: string | null = null;
    let createdSandboxId: string | null = null;
    let createdExternalId: string | null = null;
    let providerRequested: ProviderName | null = null;
    let providerUsed: ProviderName | null = null;

    try {
      const body = await c.req.json().catch(() => ({}));
      const requestedProvider = (body?.provider as ProviderName) || undefined;
      const requestedServerType = (body?.serverType as string | undefined) || undefined;
      const requestedLocation = (body?.location as string | undefined) || undefined;
      const backgroundProvisioning = Boolean(body?.backgroundProvisioning);
      const providerName = requestedProvider || getDefaultProviderName();
      providerRequested = providerName;
      const customName = body?.name as string | undefined;
      const providerDefaults = getProviderDefaults();
      const requestedOrDefaultLocation = requestedLocation || providerDefaults.location;
      const requestedOrDefaultServerType = requestedServerType || providerDefaults.serverType;

      const accountId = await resolveAccountId(userId);

      // Validate server type/location combo early so we return a clear
      // 4xx error instead of failing inside provider create with a generic 500.
      if (providerName === 'justavps') {
        const availableTypes = await listJustAVPSServerTypes(requestedOrDefaultLocation);
        const selected = availableTypes.find((st) => st.name === requestedOrDefaultServerType);
        if (!selected) {
          return c.json(
            {
              success: false,
              error: `Server type '${requestedOrDefaultServerType}' is not available in location '${requestedOrDefaultLocation}'`,
            },
            400,
          );
        }
      }

      const sandboxName = await generateSandboxName(accountId, customName);

      // Managed VPS sandboxes are billed independently as their own Stripe subscriptions.
      if (isManagedVpsProvider(providerName) && config.KORTIX_BILLING_INTERNAL_ENABLED) {
        const { getCustomerByAccountId } = await import('../../billing/repositories/customers');
        const { getOrCreateStripeCustomer } = await import('../../billing/services/subscriptions');
        const { getComputeProductId, getComputeDisplayPriceCents, getComputeDescription, COMPUTE_PRICE_MARKUP } = await import('../../billing/services/tiers');
        const { getStripe } = await import('../../shared/stripe');

        const loc = requestedOrDefaultLocation;
        const serverTypes = await listJustAVPSServerTypes(loc);
        const selectedType = serverTypes.find((st) => st.name === requestedOrDefaultServerType);

        if (!selectedType) {
          return c.json({ success: false, error: `Server type not found: ${requestedOrDefaultServerType}` }, 400);
        }

        // Use canonical display prices when available; fall back to provider price × markup.
        const monthlyPrice = getComputeDisplayPriceCents(requestedOrDefaultServerType)
          ?? Math.round(selectedType.priceMonthly * COMPUTE_PRICE_MARKUP * 100); // cents

        const stripe = getStripe();
        let customer = await getCustomerByAccountId(accountId);
        if (!customer) {
          if (!userEmail) {
            return c.json({ success: false, error: 'No billing customer found' }, 400);
          }
          const customerId = await getOrCreateStripeCustomer(accountId, userEmail);
          customer = { id: customerId } as typeof customer;
        }

        // ── Payment method check ────────────────────────────────────────────
        let defaultPaymentMethodId: string | null = null;
        try {
          const stripeCustomer = await stripe.customers.retrieve(customer.id, {
            expand: ['invoice_settings.default_payment_method'],
          });
          if (!('deleted' in stripeCustomer) || !stripeCustomer.deleted) {
            const defaultPm = stripeCustomer.invoice_settings?.default_payment_method;
            if (typeof defaultPm === 'string') {
              defaultPaymentMethodId = defaultPm;
            } else if (defaultPm && typeof defaultPm === 'object' && 'id' in defaultPm) {
              defaultPaymentMethodId = (defaultPm as { id: string }).id;
            }
          }
        } catch (pmErr) {
          console.warn('[PLATFORM] Could not retrieve customer payment method status:', pmErr);
        }

        // Fall back to checking if any card is attached
        if (!defaultPaymentMethodId) {
          try {
            const methods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 1 });
            defaultPaymentMethodId = methods.data[0]?.id ?? null;
          } catch {
            // ignore
          }
        }

        if (!defaultPaymentMethodId) {
          let portalUrl: string | null = null;
          try {
            const portalSession = await stripe.billingPortal.sessions.create({
              customer: customer.id,
              return_url: `${config.FRONTEND_URL ?? 'https://app.kortix.com'}/subscription`,
            });
            portalUrl = portalSession.url;
          } catch {
            // portal URL generation is best-effort
          }

          return c.json({
            success: false,
            error: 'No payment method on file. Please add a default payment method before creating a machine.',
            code: 'no_payment_method',
            portal_url: portalUrl,
          }, 402);
        }

        // ── Create standalone Stripe subscription for this machine ───────────
        const subscription = await stripe.subscriptions.create({
          customer: customer.id,
          items: [{
            price_data: {
              currency: 'usd',
              product: getComputeProductId(),
              unit_amount: monthlyPrice,
              recurring: { interval: 'month' },
            },
          }],
          description: getComputeDescription(requestedOrDefaultServerType),
          payment_behavior: 'error_if_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          metadata: {
            type: 'compute_instance',
            server_type: requestedOrDefaultServerType,
            location: loc,
            account_id: accountId,
          },
        });

        stripeSubscriptionId = subscription.id;
        stripeSubscriptionItemId = subscription.items.data[0]?.id ?? null;
        console.log(`[PLATFORM] Created Stripe subscription ${subscription.id} for ${providerName} machine (${requestedOrDefaultServerType}, $${(monthlyPrice / 100).toFixed(2)}/mo)`);

        if (!['active', 'trialing'].includes(subscription.status)) {
          await stripe.subscriptions.cancel(subscription.id).catch(() => {});
          return c.json({
            success: false,
            error: 'Payment failed. Please check your payment method and try again.',
            code: 'payment_failed',
          }, 402);
        }
      }

      const provider = getProvider(providerName);

      // Create sandbox row
      const [sandbox] = await db
        .insert(sandboxes)
        .values({
          accountId,
          name: sandboxName,
          provider: providerName,
          externalId: '',
          status: 'provisioning',
          baseUrl: '',
          config: {},
          metadata: stripeSubscriptionId ? { stripe_subscription_id: stripeSubscriptionId } : {},
          isIncluded: false,
          stripeSubscriptionItemId,
        })
        .returning();
      createdSandboxId = sandbox.sandboxId;

      // Create a sandbox-managed API key (kortix_sb_)
      const sandboxKey = await createApiKey({
        sandboxId: sandbox.sandboxId,
        accountId,
        title: 'Sandbox Token',
        type: 'sandbox',
      });

      // ── Try pool claim before provider.create() ──────────────────────────
      if (config.isPoolEnabled() && isManagedVpsProvider(providerName)) {
        try {
          const claimed = await pool.grab({
            serverType: requestedOrDefaultServerType,
            location: requestedOrDefaultLocation,
          });

          if (claimed) {
            await db
              .update(sandboxes)
              .set({
                externalId: claimed.externalId,
                status: 'active',
                baseUrl: claimed.baseUrl,
                metadata: {
                  ...((sandbox.metadata as Record<string, unknown>) ?? {}),
                  ...claimed.metadata,
                },
                config: { serviceKey: sandboxKey.secretKey },
                updatedAt: new Date(),
              })
              .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

            await pool.injectEnv(claimed, sandboxKey.secretKey);

            const [updated] = await db
              .select()
              .from(sandboxes)
              .where(eq(sandboxes.sandboxId, sandbox.sandboxId))
              .limit(1);

            console.log(
              `[PLATFORM] Claimed from pool: ${sandbox.sandboxId} (ext: ${claimed.externalId}) for account ${accountId}`,
            );

            return c.json(
              { success: true, data: serializeSandbox(updated), created: true },
              201,
            );
          }
        } catch (poolErr) {
          console.warn('[PLATFORM] Pool claim failed, falling back to provisioning:', poolErr);
        }
      }

      const providerCreateInput = {
        accountId,
        userId,
        name: sandboxName,
        serverType: requestedServerType,
        location: requestedLocation,
        envVars: {
          KORTIX_TOKEN: sandboxKey.secretKey,
        },
      };

      // Background provisioning mode (used by billing Add Instance flow)
      // returns quickly and continues provisioning asynchronously.
      if (backgroundProvisioning && isManagedVpsProvider(providerName)) {
        console.log(`[PLATFORM] Starting background provisioning for sandbox ${sandbox.sandboxId} (${providerName})`);

        void (async () => {
          let bgExternalId: string | null = null;
          try {
            const result = await provider.create(providerCreateInput);
            bgExternalId = result.externalId;

            await db
              .update(sandboxes)
              .set({
                externalId: result.externalId,
                status: 'active',
                baseUrl: result.baseUrl,
                metadata: { ...((sandbox.metadata as Record<string, unknown>) ?? {}), ...result.metadata },
                config: { serviceKey: sandboxKey.secretKey },
                updatedAt: new Date(),
              })
              .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

            console.log(
              `[PLATFORM] Background-provisioned sandbox ${sandbox.sandboxId} via ${providerName} ` +
              `(external: ${result.externalId}) for account ${accountId}`,
            );
          } catch (bgErr) {
            console.error(`[PLATFORM] Background provisioning failed for sandbox ${sandbox.sandboxId}:`, bgErr);
            const bgMessage = bgErr instanceof Error ? bgErr.message : String(bgErr);

            if (stripeSubscriptionId) {
              try {
                const { getStripe } = await import('../../shared/stripe');
                const stripe = getStripe();
                await stripe.subscriptions.cancel(stripeSubscriptionId);
                console.log(`[PLATFORM] Rolled back Stripe subscription ${stripeSubscriptionId} after background provisioning failure`);

                // Keep DB in sync with rollback
                await db
                  .update(sandboxes)
                  .set({ stripeSubscriptionItemId: null, updatedAt: new Date() })
                  .where(eq(sandboxes.sandboxId, sandbox.sandboxId));
              } catch (rollbackErr) {
                console.error(`[PLATFORM] Failed to roll back Stripe subscription ${stripeSubscriptionId}:`, rollbackErr);
              }
            }

            if (bgExternalId) {
              try {
                await provider.remove(bgExternalId);
                console.log(`[PLATFORM] Rolled back provider resource ${bgExternalId} after background provisioning failure`);
              } catch (cleanupErr) {
                console.error(`[PLATFORM] Failed to clean up provider resource ${bgExternalId}:`, cleanupErr);
              }
            }

            try {
              await db
                .update(sandboxes)
                .set({
                  status: 'error',
                  metadata: {
                    ...(sandbox.metadata as Record<string, unknown> || {}),
                    errorMessage: bgMessage.includes('server location disabled')
                      ? `Selected location is currently disabled by ${getProviderDisplayName(providerName)}. Choose another location.`
                      : `Provisioning failed via ${getProviderDisplayName(providerName)}. Please retry or choose a different server/location.`,
                    lastProvisioningError: bgMessage.slice(0, 500),
                  },
                  updatedAt: new Date(),
                })
                .where(eq(sandboxes.sandboxId, sandbox.sandboxId));
            } catch (markErr) {
              console.error(`[PLATFORM] Failed to mark sandbox ${sandbox.sandboxId} as error:`, markErr);
            }
          }
        })();

        return c.json(
          {
            success: true,
            data: serializeSandbox(sandbox),
            created: true,
            provisioning: true,
          },
          202,
        );
      }

      const result = await provider.create(providerCreateInput);
      createdExternalId = result.externalId;
      providerUsed = providerName;

      // Update sandbox row with provider details.
      const [updated] = await db
        .update(sandboxes)
        .set({
          externalId: result.externalId,
          status: 'active',
          baseUrl: result.baseUrl,
          metadata: { ...((sandbox.metadata as Record<string, unknown>) ?? {}), ...result.metadata },
          config: { serviceKey: sandboxKey.secretKey },
          updatedAt: new Date(),
        })
        .where(eq(sandboxes.sandboxId, sandbox.sandboxId))
        .returning();

      console.log(
        `[PLATFORM] Provisioned sandbox ${updated.sandboxId} via ${providerName} ` +
        `(external: ${result.externalId}) for account ${accountId}`,
      );

      return c.json(
        { success: true, data: serializeSandbox(updated), created: true },
        201,
      );
    } catch (err) {
      // Best-effort rollback for machine Stripe subscription
      if (stripeSubscriptionId) {
        try {
          const { getStripe } = await import('../../shared/stripe');
          const stripe = getStripe();
          await stripe.subscriptions.cancel(stripeSubscriptionId);
          console.log(`[PLATFORM] Rolled back Stripe subscription ${stripeSubscriptionId} after sandbox create failure`);
        } catch (rollbackErr) {
          console.error(`[PLATFORM] Failed to roll back Stripe subscription ${stripeSubscriptionId}:`, rollbackErr);
        }
      }

      // Best-effort cleanup for partially provisioned server
      if (providerUsed && createdExternalId) {
        try {
          const provider = getProvider(providerUsed);
          await provider.remove(createdExternalId);
          console.log(`[PLATFORM] Rolled back provider resource ${createdExternalId} after sandbox create failure`);
        } catch (cleanupErr) {
          console.error(`[PLATFORM] Failed to clean up provider resource ${createdExternalId}:`, cleanupErr);
        }
      }

      // Archive sandbox row if it was created but provisioning failed
      if (createdSandboxId) {
        try {
          await db
            .update(sandboxes)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(eq(sandboxes.sandboxId, createdSandboxId));
        } catch (archiveErr) {
          console.error(`[PLATFORM] Failed to archive failed sandbox ${createdSandboxId}:`, archiveErr);
        }
      }

      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('JustAVPS API POST /machines returned 422')) {
        console.error('[SANDBOX-CLOUD] create validation error:', err);
        return c.json(
          {
            success: false,
            error: message.includes('image disk is bigger than server type disk')
              ? 'Selected server type is incompatible with the current image size. Choose a larger instance.'
              : `${getProviderDisplayName(providerRequested || 'justavps')} rejected server creation for this configuration.`,
          },
          400,
        );
      }

      console.error('[SANDBOX-CLOUD] create error:', err);
      return c.json({ success: false, error: 'Failed to create sandbox' }, 500);
    }
  });

  
  // ─── GET /:sandboxId/status ─────────────────────────────────────────────
  // Provisioning status for frontend poller (useSandboxPoller).

  router.get('/:sandboxId/status', async (c) => {
    const userId = c.get('userId');
    const sandboxId = c.req.param('sandboxId');

    try {
      const accountId = await resolveAccountId(userId);

      const [sandbox] = await db
        .select()
        .from(sandboxes)
        .where(
          and(
            eq(sandboxes.accountId, accountId),
            eq(sandboxes.sandboxId, sandboxId),
          ),
        )
        .limit(1);

      if (!sandbox) {
        return c.json({ status: 'not_found', error: 'Sandbox not found' }, 404);
      }

      const metadata = (sandbox.metadata as Record<string, unknown> | null) ?? {};
      const currentStatus = sandbox.status;

      // NOTE: Self-healing is now handled by the background provision-poller service
      // (sandbox-provision-poller.ts) which polls JustAVPS every 8s for all provisioning
      // sandboxes. This endpoint just reads the DB — no more blocking 5-6s JustAVPS
      // calls in the hot path.

      const provisioningStage = (metadata.provisioningStage as string) ?? null;
      const provisioningMessage = (metadata.provisioningMessage as string) ?? null;
      const publicIp = (metadata.publicIp as string) ?? null;
      const serverType = (metadata.serverType as string) ?? null;
      const location = (metadata.location as string) ?? null;

      // Map sandbox DB status to the poller's expected shape
      const stageMap: Record<string, number> = {
        server_creating: 10,
        server_created: 25,
        cloud_init_running: 40,
        cloud_init_done: 55,
        docker_pulling: 65,
        docker_running: 80,
        services_starting: 90,
        services_ready: 95, // Not 100 — sandbox is still provisioning until health probe passes
      };

      let stageProgress: number | null = null;
      if (currentStatus === 'active') {
        stageProgress = 100;
      } else if (currentStatus === 'provisioning') {
        stageProgress = provisioningStage ? (stageMap[provisioningStage] ?? 20) : 8;
      } else if (currentStatus === 'error') {
        stageProgress = 0;
      }

      return c.json({
        status: currentStatus,
        stage: provisioningStage,
        stageProgress,
        stageMessage: provisioningMessage,
        machineInfo: publicIp ? { ip: publicIp, serverType: serverType ?? '', location: location ?? '' } : null,
        stages: null,
        error: currentStatus === 'error' ? ((metadata.errorMessage as string) ?? 'Provisioning failed') : null,
        startedAt: sandbox.createdAt?.toISOString() ?? null,
      });
    } catch (err) {
      console.error('[SANDBOX-CLOUD] status error:', err);
      return c.json({ status: 'error', error: 'Failed to get sandbox status' }, 500);
    }
  });

  // ─── GET /list ─────────────────────────────────────────────────────────
  // List all sandboxes for the account (all statuses).

  router.get('/list', async (c) => {
    const userId = c.get('userId');

    try {
      const accountId = await resolveAccountId(userId);
      const requestedSandboxId = c.req.query('sandbox_id') || undefined;
      const adminAccess = requestedSandboxId ? await isPlatformAdmin(accountId) : false;

      const query = requestedSandboxId
        ? (adminAccess
            ? eq(sandboxes.sandboxId, requestedSandboxId)
            : and(eq(sandboxes.accountId, accountId), eq(sandboxes.sandboxId, requestedSandboxId)))
        : eq(sandboxes.accountId, accountId);

      const rows = await db
        .select()
        .from(sandboxes)
        .where(query)
        .orderBy(desc(sandboxes.createdAt));

      return c.json({ success: true, data: rows.map(serializeSandbox) });
    } catch (err) {
      console.error('[SANDBOX-CLOUD] list error:', err);
      return c.json({ success: false, error: 'Failed to list sandboxes' }, 500);
    }
  });

  // ─── POST /stop ────────────────────────────────────────────────────────
  // Stop a specific sandbox (by `sandbox_id` in body) or the user's active
  // sandbox if no id is provided. Accepting `sandbox_id` lets the /instances
  // page stop any instance the user owns, not just the newest one.

  router.post('/stop', async (c) => {
    const userId = c.get('userId');

    try {
      const body = await c.req.json().catch(() => ({}));
      const requestedSandboxId = body?.sandbox_id as string | undefined;
      const { sandbox } = await findAccessibleSandbox(userId, requestedSandboxId, { defaultStatus: 'active' });

      if (!sandbox) {
        return c.json({ success: false, error: 'No active sandbox to stop' }, 404);
      }

      if (!sandbox.externalId) {
        return c.json({ success: false, error: 'Sandbox has no external ID' }, 400);
      }

      const provider = getProvider(sandbox.provider);
      await provider.stop(sandbox.externalId);

      await db
        .update(sandboxes)
        .set({ status: 'stopped', updatedAt: new Date() })
        .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

      console.log(`[PLATFORM] Stopped sandbox ${sandbox.sandboxId} via ${sandbox.provider}`);

      return c.json({ success: true });
    } catch (err) {
      console.error('[SANDBOX-CLOUD] stop error:', err);
      return c.json({ success: false, error: 'Failed to stop sandbox' }, 500);
    }
  });

  // ─── POST /restart ─────────────────────────────────────────────────────
  // Restart a specific sandbox (by `sandbox_id` in body) or the user's most
  // recently created sandbox if no id is provided. Accepting `sandbox_id`
  // lets the /instances page restart any instance directly from its card.

  router.post('/restart', async (c) => {
    const userId = c.get('userId');

    try {
      const body = await c.req.json().catch(() => ({}));
      const requestedSandboxId = body?.sandbox_id as string | undefined;
      const { access, sandbox } = await findAccessibleSandbox(userId, requestedSandboxId);

      if (!sandbox || !sandbox.externalId) {
        console.warn('[SANDBOX-CLOUD] restart target not found', {
          accountId: access.accountId,
          isAdmin: access.isAdmin,
          requestedSandboxId,
        });
        return c.json({ success: false, error: 'No sandbox to restart' }, 404);
      }

      const provider = getProvider(sandbox.provider);

      if (sandbox.provider === 'justavps') {
        const { JustAVPSProvider } = await import('../providers/justavps');
        const justavpsProvider = provider as InstanceType<typeof JustAVPSProvider>;
        const serviceKey = (sandbox.config as Record<string, unknown>)?.serviceKey as string || '';
        void justavpsProvider.ensureRunning(sandbox.externalId).then(() => {
          if (serviceKey) return pool.injectEnv({ baseUrl: sandbox.baseUrl, metadata: sandbox.metadata ?? {}, externalId: sandbox.externalId! }, serviceKey);
        }).catch((error: unknown) => {
          console.error(`[PLATFORM] Async workload recovery failed for ${sandbox.sandboxId}:`, error);
        });

        await db
          .update(sandboxes)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

        const [refreshed] = await db
          .select()
          .from(sandboxes)
          .where(eq(sandboxes.sandboxId, sandbox.sandboxId))
          .limit(1);

        console.log(`[PLATFORM] Dispatched workload recovery for sandbox ${sandbox.sandboxId} via ${sandbox.provider}`);

        return c.json({ success: true, data: { ...(refreshed ? serializeSandbox(refreshed) : {}), recovery_state: 'restarting_workload', action: 'restart_workload' } });
      }

      // Stop if running
      if (sandbox.status === 'active') {
        try {
          await provider.stop(sandbox.externalId);
        } catch {
          // May already be stopped
        }
      }

      // Start
      await provider.start(sandbox.externalId);

      await db
        .update(sandboxes)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

      const [refreshed] = await db
        .select()
        .from(sandboxes)
        .where(eq(sandboxes.sandboxId, sandbox.sandboxId))
        .limit(1);

      console.log(`[PLATFORM] Restarted sandbox ${sandbox.sandboxId} via ${sandbox.provider}`);

      return c.json({ success: true, data: refreshed ? serializeSandbox(refreshed) : undefined });
    } catch (err) {
      console.error('[SANDBOX-CLOUD] restart error:', err);
      return c.json({ success: false, error: 'Failed to restart sandbox' }, 500);
    }
  });

  // ─── POST /cancel ──────────────────────────────────────────────────────
  // Schedule a VPS sandbox for cancellation at end of billing period.
  // The sandbox's standalone Stripe subscription remains active until period end.

  router.post('/cancel', async (c) => {
    const userId = c.get('userId');

    try {
      const accountId = await resolveAccountId(userId);
      const body = await c.req.json().catch(() => ({}));
      const sandboxId = body?.sandbox_id as string | undefined;

      const query = sandboxId
        ? and(eq(sandboxes.accountId, accountId), eq(sandboxes.sandboxId, sandboxId), sql`${sandboxes.status} != 'archived'`)
        : and(eq(sandboxes.accountId, accountId), sql`${sandboxes.status} != 'archived'`);

      const [sandbox] = await db.select().from(sandboxes).where(query).limit(1);

      if (!sandbox) {
        return c.json({ success: false, error: 'No sandbox found' }, 404);
      }

      const existingMeta = (sandbox.metadata as Record<string, unknown> | null) ?? {};
      const isAlreadyCancelling = Boolean((existingMeta.cancel_at_period_end as boolean) ?? false);
      const { cancel_at_period_end: _ignoreCancelFlag, cancel_at: _ignoreCancelAt, ...cleanMeta } = existingMeta as Record<string, unknown> & {
        cancel_at_period_end?: boolean;
        cancel_at?: string;
      };

      if (isAlreadyCancelling) {
        return c.json({ success: false, error: 'Sandbox is already scheduled for cancellation' }, 400);
      }

      let cancelAt: string | null = null;

      const stripeSubId = existingMeta.stripe_subscription_id as string | undefined;
      if (stripeSubId && config.KORTIX_BILLING_INTERNAL_ENABLED) {
        try {
          const { getStripe } = await import('../../shared/stripe');
          const stripe = getStripe();
          const sub = await stripe.subscriptions.update(stripeSubId, {
            cancel_at_period_end: true,
          });
          const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
          if (periodEnd) {
            cancelAt = new Date(periodEnd * 1000).toISOString();
          }
        } catch (err) {
          console.warn('[PLATFORM] Could not retrieve Stripe period end for cancel:', err);
        }
      }

      await db
        .update(sandboxes)
        .set({
          metadata: {
            ...cleanMeta,
            cancel_at_period_end: true,
            ...(cancelAt ? { cancel_at: cancelAt } : {}),
          },
          updatedAt: new Date(),
        })
        .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

      console.log(`[PLATFORM] Scheduled sandbox ${sandbox.sandboxId} for cancellation`);
      return c.json({ success: true, cancel_at: cancelAt });
    } catch (err) {
      console.error('[SANDBOX-CLOUD] cancel error:', err);
      return c.json({ success: false, error: 'Failed to schedule cancellation' }, 500);
    }
  });

  // ─── POST /reactivate ──────────────────────────────────────────────────
  // Reverse a scheduled cancellation.

  router.post('/reactivate', async (c) => {
    const userId = c.get('userId');

    try {
      const accountId = await resolveAccountId(userId);
      const body = await c.req.json().catch(() => ({}));
      const sandboxId = body?.sandbox_id as string | undefined;

      const query = sandboxId
        ? and(eq(sandboxes.accountId, accountId), eq(sandboxes.sandboxId, sandboxId), sql`${sandboxes.status} != 'archived'`)
        : and(eq(sandboxes.accountId, accountId), sql`${sandboxes.status} != 'archived'`);

      const [sandbox] = await db.select().from(sandboxes).where(query).limit(1);

      if (!sandbox) {
        return c.json({ success: false, error: 'No sandbox found' }, 404);
      }

      const existingMeta = (sandbox.metadata as Record<string, unknown> | null) ?? {};
      const isCancelling = Boolean((existingMeta.cancel_at_period_end as boolean) ?? false);
      const { cancel_at_period_end: _ignoreCancelFlag, cancel_at: _ignoreCancelAt, ...cleanMeta } = existingMeta as Record<string, unknown> & {
        cancel_at_period_end?: boolean;
        cancel_at?: string;
      };

      if (!isCancelling) {
        return c.json({ success: false, error: 'Sandbox is not scheduled for cancellation' }, 400);
      }

      const stripeSubId = existingMeta.stripe_subscription_id as string | undefined;
      if (stripeSubId && config.KORTIX_BILLING_INTERNAL_ENABLED) {
        try {
          const { getStripe } = await import('../../shared/stripe');
          const stripe = getStripe();
          await stripe.subscriptions.update(stripeSubId, {
            cancel_at_period_end: false,
          });
        } catch (err) {
          console.warn('[PLATFORM] Could not reverse Stripe cancellation for sandbox:', err);
        }
      }

      await db
        .update(sandboxes)
        .set({ metadata: cleanMeta, updatedAt: new Date() })
        .where(eq(sandboxes.sandboxId, sandbox.sandboxId));

      console.log(`[PLATFORM] Reactivated sandbox ${sandbox.sandboxId} (cancellation reversed)`);
      return c.json({ success: true });
    } catch (err) {
      console.error('[SANDBOX-CLOUD] reactivate error:', err);
      return c.json({ success: false, error: 'Failed to reactivate sandbox' }, 500);
    }
  });

  router.post('/claim-computer', async (c) => {
    const userId = c.get('userId');
    try {
      const accountId = await resolveAccountId(userId);
      // 1. Verify legacy paid tier from canonical kortix billing state only.
      const { getCreditAccount } = await import('../../billing/repositories/credit-accounts');
      const { isLegacyPaidTier, getTier } = await import('../../billing/services/tiers');

      const account = await getCreditAccount(accountId);
      const tier = account?.tier ?? 'free';

      if (!isLegacyPaidTier(tier)) {
        return c.json({ success: false, error: 'Only legacy paid plan users can claim a computer' }, 403);
      }

      const existing = await db
        .select({ sandboxId: sandboxes.sandboxId })
        .from(sandboxes)
        .where(and(eq(sandboxes.accountId, accountId), inArray(sandboxes.status, ['active', 'provisioning'])))
        .limit(1);

      if (existing.length > 0) {
        return c.json({ success: false, error: 'You already have an active computer', sandbox_id: existing[0].sandboxId }, 409);
      }

      // Lazy-migrate: create kortix.credit_accounts row with full credits.
      // Supabase RPCs can't access kortix schema, so set everything via drizzle directly.
      try {
        const { MACHINE_CREDIT_BONUS } = await import('../../billing/services/tiers');
        const { grantMachineBonusOnce, getLegacyClaimMachineBonusKey } = await import('../../billing/services/machine-bonus');

        const tierConfig = getTier(tier);
        const monthlyCredits = tierConfig.monthlyCredits;

        // Best-effort: ledger entries for audit trail (bonus uses drizzle fallback, works fine)
        await grantMachineBonusOnce({ accountId, idempotencyKey: getLegacyClaimMachineBonusKey(accountId) });
        console.log(`[claim-computer] Migrated ${accountId}: tier=${tier}, credits=$${monthlyCredits}+$${MACHINE_CREDIT_BONUS} bonus`);
      } catch (err) {
        console.error(`[claim-computer] Credit grant failed for ${accountId}:`, err);
      }

      const { createSandbox } = await import('../services/ensure-sandbox');
      const result = await createSandbox({ accountId, userId, provider: 'justavps', isIncluded: true });

      if (!result.row) {
        return c.json({ success: false, error: 'Failed to create sandbox' }, 500);
      }

      console.log(`[claim-computer] ${result.row.sandboxId} for ${accountId} (tier=${tier})`);
      return c.json({
        success: true,
        data: serializeSandbox(result.row),
        provisioning: result.row.status === 'provisioning',
      }, result.row.status === 'active' ? 201 : 202);
    } catch (err) {
      console.error('[claim-computer] error:', err);
      return c.json({ success: false, error: 'Failed to claim computer' }, 500);
    }
  });

  router.post('/mark-error', async (c) => {
    const userId = c.get('userId');
    const accountId = await resolveAccountId(userId);
    const body = await c.req.json().catch(() => ({}));
    const sandboxId = body?.sandbox_id as string | undefined;
    const errorMessage = (body?.error_message as string | undefined) || 'Health check timed out after provisioning.';

    if (!sandboxId) {
      return c.json({ error: 'sandbox_id required' }, 400);
    }

    const [row] = await db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.sandboxId, sandboxId), eq(sandboxes.accountId, accountId)))
      .limit(1);

    if (!row) {
      return c.json({ error: 'Sandbox not found' }, 404);
    }

    // Only mark active/provisioning sandboxes as error — don't overwrite an already-error record
    if (!['active', 'provisioning'].includes(row.status)) {
      return c.json({ success: true, status: row.status });
    }

    await db
      .update(sandboxes)
      .set({
        status: 'error',
        metadata: {
          ...(row.metadata as Record<string, unknown> | null ?? {}),
          errorMessage,
        },
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.sandboxId, sandboxId));

    console.log(`[SANDBOX-CLOUD] Marked sandbox ${sandboxId} as error: ${errorMessage}`);
    return c.json({ success: true });
  });

  return router;
}

export const cloudSandboxRouter = createCloudSandboxRouter();
