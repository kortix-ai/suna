/**
 * Admin console API (revived for the current backend).
 *
 * Mounted at /v1/admin, gated by supabaseAuth + requireAdmin (platform role
 * 'admin' | 'super_admin' in kortix.platform_user_roles). Backs the web admin
 * pages under apps/web/src/app/admin/.
 *
 * Scope (v1): the safe accounts console — list accounts (filterable by tier,
 * payment status, paid-only, and subscription presence), account members,
 * credit ledger, and grant/debit credits (through the billing wallet). Stripe customer id/email are still returned as null (no join yet);
 * the legacy env/exec/schema endpoints are intentionally NOT restored.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types/app-env';
import { supabaseAuth } from '../middleware/auth';
import { requestClientIp } from '../../lib/client-ip';
import { requireAdmin } from '../middleware/require-admin';
import { makeOpenApiApp, json, errors, auth } from '../openapi';
import { analyticsApp } from './analytics';
import { isUuid } from '../../lib/validate';
import { readJsonObject } from '../../lib/http-body';
import { errorSqlstate } from '../../lib/error-cause';
import {
  deleteSessionSandbox,
  findAccountName,
  findProject,
  findProjectSession,
  findSessionSandbox,
  listAccountNames,
  listAdminAccountMembers,
  listAdminAccountProjects,
  listAdminAccountsPage,
  listAdminCreditLedger,
  listAdminProjectsPage,
  listAdminSandboxes,
  listProviderEventsSince,
  readProviderDistribution,
  saveProviderDistribution,
  saveProviderFallback,
} from '../../services/admin/queries';
import { summarizeProviderAnalytics } from '../../services/admin/provider-analytics';

/** SQLSTATE Postgres raises when `statement_timeout` cancels a query. */
const STATEMENT_TIMEOUT_SQLSTATE = '57014';

export const adminApp = makeOpenApiApp<AppEnv>();

// Drizzle wraps the Postgres error: `e.message` is "Failed query: <sql> …" and
// the real reason (undefined column, statement timeout, constraint) hides in
// `e.cause`. Admin 500s must name that cause — a bare "Failed query" toast
// sends an operator hunting through prod logs for what the response could
// have carried.
export function adminErrorMessage(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } } | null;
  const message = err?.message || String(e);
  const cause = err?.cause?.message;
  return cause && !message.includes(cause) ? `${message} — cause: ${cause}` : message;
}

/**
 * Stable code the API returns (HTTP 503) when the admin accounts-list query
 * (`accounts LEFT JOIN credit_accounts`, ordered/paginated) cannot complete
 * inside the database statement budget — in practice a `statement_timeout`
 * (SQLSTATE 57014). Before `idx_accounts_created_at` existed, `accounts` had
 * only its primary key, so the planner could not drive the `ORDER BY
 * created_at` from an index and instead Hash-Joined full sequential scans of
 * `accounts` and `credit_accounts` (234.5k rows, prod 2026-09-27) and sorted
 * the whole result before applying `LIMIT` — measured on prod at
 * 25013/25019/25056 ms against the 25s budget (2026-09-27T01:21-01:22Z). The
 * unguarded catch below echoed `adminErrorMessage(e)` — which deliberately
 * includes the raw `Failed query: select …` text for OTHER admin errors — into
 * the 500 body, leaking the query (including
 * `"kortix"."credit_accounts"."balance_precise"`) to the browser. This is an
 * EXPECTED capacity state, not a defect, so `makeRequest` in
 * `packages/sdk/src/core/http/api-client.ts` classifies a 503 carrying this
 * code as SILENT to `onError` (Sentry). Must stay in sync with
 * `ACCOUNTS_LIST_UNAVAILABLE_CODE` there. Mirrors `ANALYTICS_UNAVAILABLE_CODE`
 * in `apps/api/src/http/admin/analytics.ts` (#7770 / KRTX-423).
 */
export const ACCOUNTS_LIST_UNAVAILABLE_CODE = 'accounts_list_unavailable';

/** User-facing sentence for the typed 503 above. Never contains SQL or a table name. */
const ACCOUNTS_LIST_UNAVAILABLE_MESSAGE =
  'The accounts list is temporarily unavailable. Try again in a moment.';

function accountsListUnavailableBody(): Record<string, unknown> {
  return {
    error: true,
    code: ACCOUNTS_LIST_UNAVAILABLE_CODE,
    message: ACCOUNTS_LIST_UNAVAILABLE_MESSAGE,
    status: 503,
  };
}

// Every admin route requires a logged-in platform admin.
adminApp.use('*', supabaseAuth, requireAdmin);

// Activity analytics. Mounted HERE — directly after the gate above and before
// any route definition — so it inherits supabaseAuth + requireAdmin instead of
// re-declaring them. `analyticsApp` carries no middleware of its own; moving
// this line above the `use('*')` would publish platform-wide activity data to
// anonymous callers. `analytics-mount.test.ts` fails if that happens.
adminApp.route('/analytics', analyticsApp);

// ── List accounts ────────────────────────────────────────────────────────────
adminApp.openapi(
  createRoute({
    method: 'get',
    path: '/api/accounts',
    tags: ['admin'],
    summary: 'List accounts (admin console)',
    ...auth,
    request: {
      query: z.object({
        search: z.string().optional(),
        accountId: z.string().optional(),
        tier: z.string().optional(),
        paymentStatus: z.string().optional(),
        paid: z.string().optional(),
        hasSubscription: z.string().optional(),
        minBalance: z.string().optional(),
        maxBalance: z.string().optional(),
        sortBy: z.string().optional(),
        sortDir: z.string().optional(),
        page: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: json(z.record(z.string(), z.any()), 'Accounts page'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      503: json(z.record(z.string(), z.any()), 'Accounts list temporarily unavailable'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const { parseAdminAccountsListQuery } = await import('../../services/admin/accounts-query');
    const { accountDisplayName } = await import('../../services/accounts/core/account-name');
    // PURE resolver — no I/O, no cache, no clock of its own. It runs over the
    // row this query already selects, so the `plan` block below costs zero
    // extra queries (no N+1) and reports the same plan every server gate
    // enforces for that account.
    const { resolveBillingFromRow } = await import('../../services/billing/services/resolve-billing');

    const query = parseAdminAccountsListQuery((k: string) => c.req.query(k));
    const { page, limit } = query;

    // Both reads run inside their own guard: `accounts LEFT JOIN
    // credit_accounts` ordered/paginated (or counted) is the query that hit
    // the 25s request-path statement_timeout on prod (57014) — see
    // `ACCOUNTS_LIST_UNAVAILABLE_CODE` above for the full incident. That is an
    // EXPECTED capacity state, not a defect, so it gets a typed 503 instead of
    // falling into the outer catch's `adminErrorMessage(e)`, which
    // deliberately includes the raw `Failed query: select …` text for other
    // (genuine) admin errors.
    const queryResult = await (async () => {
      try {
        return { ok: true as const, ...(await listAdminAccountsPage(query)) };
      } catch (error) {
        if (errorSqlstate(error) === STATEMENT_TIMEOUT_SQLSTATE) {
          console.error('[admin/accounts] list query failed — returning typed unavailability:', error);
          return { ok: false as const };
        }
        throw error;
      }
    })();
    if (!queryResult.ok) return c.json(accountsListUnavailableBody(), 503);
    const { rows, total } = queryResult;

    const now = Date.now();
    const list = rows.map((r) => {
      // The plan the account BEHAVES as: an active admin trial and the
      // per-seat self-heal overlay the stored `tier`, and that is what every
      // gate enforces. `tier` below stays the STORED column — the tier filter
      // matches on it server-side, so the two must keep meaning the same thing.
      const resolved = resolveBillingFromRow(r, now);
      return {
        accountId: r.accountId,
        name: r.name,
        // The name the PRODUCT shows for this account. `name` above is the raw
        // stored column, which for old rows is a migration placeholder
        // ('Personal' / 'User') that every customer-facing surface maps to a
        // suggested name (`defaultAccountName`) — the console must render the same thing,
        // or an operator searching for what the customer sees finds "Personal".
        displayName: accountDisplayName(r.name, r.ownerEmail ?? null),
        ownerEmail: r.ownerEmail ?? null,
        memberCount: Number(r.memberCount ?? 0),
        balance: r.balance ?? null,
        expiringCredits: r.expiringCredits ?? null,
        nonExpiringCredits: r.nonExpiringCredits ?? null,
        dailyCreditsBalance: r.dailyCreditsBalance ?? null,
        tier: r.tier ?? null,
        // RESOLVED plan, named the way the product names plans (Free / Team /
        // Enterprise + a qualifier). The console renders this instead of mapping
        // the raw key onto a hand-maintained label table of its own.
        plan: {
          key: resolved.plan.key,
          family: resolved.plan.family,
          label: resolved.display.label,
          sublabel: resolved.display.sublabel,
          status: resolved.plan.status,
          is_grandfathered: resolved.plan.status === 'grandfathered',
        },
        paymentStatus: r.paymentStatus ?? null,
        provider: r.provider ?? null,
        planType: r.planType ?? null,
        stripeSubscriptionId: r.stripeSubscriptionId ?? null,
        billingModel: r.billingModel ?? null,
        seatCount: r.seatCount ?? null,
        trial: {
          status: r.trialStatus ?? 'none',
          tier: r.trialTier ?? null,
          seats: r.trialSeats ?? null,
          startedAt: r.trialStartedAt ?? null,
          endsAt: r.trialEndsAt ?? null,
          note: r.trialNote ?? null,
        },
        managedModelsOverride: r.managedModelsOverride ?? null,
        demoEnterprise: r.demoEnterprise ?? false,
        enterpriseEntitled: r.enterpriseEntitled ?? false,
        // The stored override map, exactly as PUT /accounts/{id}/overrides left
        // it. Expiry is NOT applied here — the console shows an operator what
        // is on the row, including entries that have lapsed; `resolved` above
        // is what the gates enforce.
        entitlementOverrides: r.entitlementOverrides ?? {},
        computeRateMultiplier: resolved.compute.rateMultiplier,
        // Stripe customer id/email aren't on credit_accounts — left null until a
        // billing-customers join is added; the console degrades gracefully.
        billingCustomerId: null,
        billingCustomerEmail: null,
        createdAt: r.createdAt ? new Date(r.createdAt as any).toISOString() : null,
      };
    });

    return c.json({ accounts: list, total: Number(total ?? 0), page, limit, summary: null });
  } catch (e: any) {
    return c.json({ accounts: [], total: 0, page: 1, limit: 50, summary: null, error: adminErrorMessage(e) }, 500);
  }
  },
);
// ── Account members ──────────────────────────────────────────────────────────
adminApp.openapi(
  createRoute({
    method: 'get',
    path: '/api/accounts/{id}/users',
    tags: ['admin'],
    summary: 'List members of an account',
    ...auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(z.object({ users: z.array(z.any()) }), 'Account members'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const accountId = c.req.param('id');
    const users = await listAdminAccountMembers(accountId);
    return c.json({ users });
  } catch (e: any) {
    return c.json({ users: [], error: adminErrorMessage(e) }, 500);
  }
  },
);

// ── Set a member's role ──────────────────────────────────────────────────────
// Platform-admin override of the in-account role system: the customer-facing
// PATCH /accounts/:id/members/:userId requires the caller to be a member (and
// owner-role changes require an owner), which support staff are not. This route
// bypasses membership but keeps the one hard invariant: an account never drops
// to zero owners.
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/members/{userId}/role',
    tags: ['admin'],
    summary: "Set an account member's role (platform-admin override)",
    ...auth,
    request: {
      params: z.object({ id: z.string(), userId: z.string() }),
      body: {
        content: {
          'application/json': { schema: z.object({ role: z.string() }) },
        },
      },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), user_id: z.string(), account_role: z.string() }),
        'Updated member role',
      ),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      404: json(z.record(z.string(), z.any()), 'Not a member'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const accountId = c.req.param('id');
    const userId = c.req.param('userId');
    const actorUserId = c.get('userId') as string | undefined;
    const body = await readJsonObject(c);
    const roleRaw = String(body.role || '').trim();

    if (roleRaw !== 'owner' && roleRaw !== 'admin' && roleRaw !== 'member') {
      return c.json({ error: 'role must be one of owner|admin|member' }, 400);
    }
    const role = roleRaw;

    // The role comes from `role_assignments`, not from the legacy column: an
    // assignment written straight through `assignRole()` leaves that column
    // stale on purpose, and this console must not act on a stale value.
    const { accountRoleFor, countAccountOwners } = await import('../../services/iam/read-models');
    const assignmentsModule = await import('../../services/iam/assignments');
    const { assignRole } = assignmentsModule;
    const currentRole = await accountRoleFor(accountId, userId);
    if (!currentRole) return c.json({ error: 'user is not a member of this account' }, 404);
    const target = { accountRole: currentRole };
    if (currentRole === role) {
      return c.json({ ok: true, user_id: userId, account_role: role });
    }

    // Never demote the last owner — an ownerless account is unrecoverable
    // through the product (every owner-gated route would 403 forever).
    if (currentRole === 'owner' && role !== 'owner') {
      if ((await countAccountOwners(accountId)) <= 1) {
        return c.json({ error: 'cannot demote the last owner of an account' }, 400);
      }
    }

    // THE write. `SYSTEM_ACTOR`: the writer is a platform operator, not a member
    // of this account — they hold no role in it to authorize against, which is
    // exactly what the platform-admin gate on this route already established.
    // `exclusive` retracts the role being replaced, so a demotion is a demotion.
    await assignRole(assignmentsModule.SYSTEM_ACTOR, accountId, {
      principal: { type: 'user', id: userId },
      roleKey: role,
      scope: { type: 'account' },
      source: 'system',
      exclusive: true,
    });

    try {
      const { recordAuditEvent } = await import('../../services/audit/audit');
      await recordAuditEvent({
        accountId,
        actorUserId,
        action: 'admin.account.member_role.set',
        resourceType: 'account_member',
        resourceId: userId,
        before: { account_role: target.accountRole },
        after: { account_role: role },
        ip: requestClientIp(c),
        userAgent: c.req.header('user-agent') || null,
      });
    } catch {
      /* audit is best-effort — never block the role change */
    }

    return c.json({ ok: true, user_id: userId, account_role: role });
  } catch (e: any) {
    return c.json({ error: adminErrorMessage(e) }, 500);
  }
  },
);

// ── Account projects ─────────────────────────────────────────────────────────
// Everything an account owns on the project-first model — the support-desk
// view: "search a user, see every project they have, click straight in."
// Pairs with the ADMIN BYPASS button on the project access-request screen
// (apps/web/.../project-access-boundary.tsx), which lets a platform admin
// open one of these links even with no account/project membership.
adminApp.openapi(
  createRoute({
    method: 'get',
    path: '/api/accounts/{id}/projects',
    tags: ['admin'],
    summary: 'List projects owned by an account',
    ...auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(z.object({ projects: z.array(z.any()) }), 'Account projects'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const accountId = c.req.param('id');
    const rows = await listAdminAccountProjects(accountId);

    return c.json({
      projects: rows.map((r) => ({
        ...r,
        sessionCount: Number(r.sessionCount ?? 0),
        activeSessionCount: Number(r.activeSessionCount ?? 0),
      })),
    });
  } catch (e: any) {
    return c.json({ projects: [], error: adminErrorMessage(e) }, 500);
  }
  },
);

// ── All projects, across every account ───────────────────────────────────────
// The fleet view the per-account list above cannot give you: "what is actually
// being worked on right now", most-active first. Sorting on `lastSessionAt`
// (the newest session's created_at) rather than `projects.updated_at` is
// deliberate — `updated_at` moves for metadata writes that no human caused, so
// it reports touched, not active. NULLS LAST keeps never-run projects out of
// the top of the default view instead of ahead of it.
adminApp.openapi(
  createRoute({
    method: 'get',
    path: '/api/projects',
    tags: ['admin'],
    summary: 'List projects across all accounts (admin console)',
    ...auth,
    request: {
      query: z.object({
        search: z.string().optional(),
        accountId: z.string().optional(),
        status: z.string().optional(),
        sortBy: z.string().optional(),
        sortDir: z.string().optional(),
        page: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: json(z.record(z.string(), z.any()), 'Projects page'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const { parseAdminProjectsListQuery } = await import('../../services/admin/projects-query');

    const query = parseAdminProjectsListQuery((k: string) => c.req.query(k));
    const { invalidAccountId, page, limit } = query;

    // A malformed accountId narrows to nothing rather than widening to
    // everything — an operator who mistypes an id must not be handed the fleet.
    if (invalidAccountId) {
      return c.json({ projects: [], total: 0, page, limit });
    }

    const { rows, total } = await listAdminProjectsPage(query);

    const list = rows.map((r) => ({
      projectId: r.projectId,
      name: r.name,
      status: r.status ?? null,
      accountId: r.accountId,
      accountName: r.accountName ?? null,
      ownerEmail: r.ownerEmail ?? null,
      createdAt: r.createdAt ? new Date(r.createdAt as any).toISOString() : null,
      sessionCount: Number(r.sessionCount ?? 0),
      activeSessionCount: Number(r.activeSessionCount ?? 0),
      lastSessionAt: r.lastSessionAt ? new Date(r.lastSessionAt as any).toISOString() : null,
    }));

    return c.json({ projects: list, total: Number(total ?? 0), page, limit });
  } catch (e: any) {
    return c.json({ projects: [], total: 0, page: 1, limit: 50, error: adminErrorMessage(e) }, 500);
  }
  },
);

// ── Credit ledger ────────────────────────────────────────────────────────────
adminApp.openapi(
  createRoute({
    method: 'get',
    path: '/api/accounts/{id}/ledger',
    tags: ['admin'],
    summary: 'List credit ledger entries for an account',
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ limit: z.string().optional() }),
    },
    responses: {
      200: json(z.object({ entries: z.array(z.any()) }), 'Credit ledger entries'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const accountId = c.req.param('id');
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
    const entries = await listAdminCreditLedger(accountId, limit);
    return c.json({ entries });
  } catch (e: any) {
    return c.json({ entries: [], error: adminErrorMessage(e) }, 500);
  }
  },
);

// ── Live Stripe subscription ─────────────────────────────────────────────────
// What Stripe ACTUALLY charges, rendered next to the resolved plan badge. The
// badge alone let a stored 'pro' tier read "Team · $20/mo · grandfathered"
// while the customer's real subscription was a $40/mo legacy machine sub.
adminApp.openapi(
  createRoute({
    method: 'get',
    path: '/api/accounts/{id}/subscription',
    tags: ['admin'],
    summary: "The account's live Stripe subscription, as Stripe reports it",
    ...auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(z.record(z.string(), z.any()), 'Live subscription, or null when none is on file'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const accountId = c.req.param('id');
    if (!isUuid(accountId)) return c.json({ subscription: null });
    const { getCreditAccount } = await import('../../services/billing/repositories/credit-accounts');
    const account = await getCreditAccount(accountId);
    const subscriptionId = account?.stripeSubscriptionId ?? null;
    if (!subscriptionId) return c.json({ subscription: null });
    const { getStripe } = await import('../../services/billing/stripe');
    const sub = await getStripe().subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.product'],
    });
    const item = sub.items?.data?.[0];
    const price = item?.price;
    const product = price?.product;
    const unitAmount = price?.unit_amount ?? null;
    const quantity = item?.quantity ?? 1;
    return c.json({
      subscription: {
        id: sub.id,
        status: sub.status,
        description: sub.description ?? null,
        productName:
          product && typeof product === 'object' && 'name' in product ? product.name : null,
        priceId: price?.id ?? null,
        unitAmountUsd: unitAmount != null ? unitAmount / 100 : null,
        quantity,
        totalAmountUsd: unitAmount != null ? (unitAmount * quantity) / 100 : null,
        interval: price?.recurring?.interval ?? null,
        currency: price?.currency ?? null,
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      },
    });
  } catch (e: any) {
    return c.json({ subscription: null, error: adminErrorMessage(e) }, 500);
  }
  },
);

/** The buckets an admin credit route echoes back; no credit row reads as empty. */
async function adminBalance(accountId: string) {
  const { wallet } = await import('../../services/billing/wallet');
  return (await wallet.balance(accountId)) ?? { balance: 0, expiring: 0, nonExpiring: 0, daily: 0 };
}

// ── Grant credits ────────────────────────────────────────────────────────────
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/credits',
    tags: ['admin'],
    summary: 'Grant credits to an account',
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              amount: z.number(),
              description: z.string().optional(),
              isExpiring: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), balance: z.any() }), 'Grant result'),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const accountId = c.req.param('id');
    const actorUserId = c.get('userId') as string | undefined;
    const body = await readJsonObject(c);
    const amount = Number(body.amount);
    const description = String(body.description || 'Admin credit grant');
    const isExpiring = body.isExpiring !== false;
    if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'amount must be a positive number' }, 400);

    const { wallet } = await import('../../services/billing/wallet');
    await wallet.grant({
      accountId,
      amount,
      kind: 'admin_grant',
      description: `${description} (by admin ${actorUserId ?? 'unknown'})`,
      expiring: isExpiring,
      key: null,
    });
    return c.json({ ok: true, balance: await adminBalance(accountId) });
  } catch (e: any) {
    return c.json({ error: adminErrorMessage(e) }, 500);
  }
  },
);

// ── Debit credits ────────────────────────────────────────────────────────────
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/credits/debit',
    tags: ['admin'],
    summary: 'Debit credits from an account',
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              amount: z.number(),
              description: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), balance: z.any() }), 'Debit result'),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const accountId = c.req.param('id');
    const actorUserId = c.get('userId') as string | undefined;
    const body = await readJsonObject(c);
    const amount = Number(body.amount);
    const description = String(body.description || 'Admin credit debit');
    if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'amount must be a positive number' }, 400);

    const { wallet } = await import('../../services/billing/wallet');
    // A negative grant of its own kind: an operator correction is not
    // customer usage, and it is not refused by the admission floor.
    await wallet.grant({
      accountId,
      amount: -Math.abs(amount),
      kind: 'admin_debit',
      description: `${description} (by admin ${actorUserId ?? 'unknown'})`,
      expiring: false,
      key: null,
    });
    return c.json({ ok: true, balance: await adminBalance(accountId) });
  } catch (e: any) {
    return c.json({ error: adminErrorMessage(e) }, 500);
  }
  },
);

// ── Set plan tier (e.g. activate Enterprise) ─────────────────────────────────
// Sales-assigned tiers (notably `enterprise`, which unlocks SSO + SCIM) have no
// self-serve path — this is the audited way to flip an account onto one. Upserts
// the credit_accounts row so it works whether or not the account has billed yet,
// and clears the tier cache so the change takes effect immediately.
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/tier',
    tags: ['admin'],
    summary: "Set an account's plan tier (e.g. activate Enterprise)",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ tier: z.string() }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), tier: z.string() }), 'Updated tier'),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const accountId = c.req.param('id');
    const actorUserId = c.get('userId') as string | undefined;
    const body = await readJsonObject(c);
    const tier = String(body.tier || '').trim();

    const { isValidTier } = await import('../../services/billing/services/tiers');
    if (!isValidTier(tier)) return c.json({ error: `unknown tier "${tier}"` }, 400);

    // Enterprise is an ENTITLEMENT, not a tier. A `tier='enterprise'` write is
    // clobbered by the next Stripe subscription sync (webhooks.ts writes the
    // price-resolved tier back), which silently reverts the account. The flag
    // survives sync — refuse the wrong primitive here.
    if (tier === 'enterprise') {
      return c.json(
        {
          error:
            "enterprise is not assignable as a tier — use POST /admin/api/accounts/{id}/enterprise-entitlement instead (the flag survives Stripe subscription sync; a tier write does not)",
        },
        400,
      );
    }

    const { getSubscriptionInfo } = await import('../../services/billing/repositories/credit-accounts');
    const { applyAdminOverride } = await import('../../services/billing/services/account-write-owner');
    const before = await getSubscriptionInfo(accountId);
    // `tier` is provider-owned everywhere else, and ADMIN_ASSIGNABLE here: an
    // operator reassigning a plan by hand is a real support operation. The
    // chokepoint still refuses 'enterprise' (the 400 above catches it first)
    // and invalidates the one billing cache the value feeds.
    await applyAdminOverride(
      accountId,
      { tier },
      { userId: actorUserId ?? null, action: 'admin.account.tier.set' },
    );

    try {
      const { recordAuditEvent } = await import('../../services/audit/audit');
      await recordAuditEvent({
        accountId,
        actorUserId,
        action: 'admin.account.tier.set',
        resourceType: 'credit_account',
        resourceId: accountId,
        before: { tier: before?.tier ?? null },
        after: { tier },
        ip: requestClientIp(c),
        userAgent: c.req.header('user-agent') || null,
      });
    } catch {
      /* audit is best-effort — never block the tier change */
    }

    return c.json({ ok: true, tier });
  } catch (e: any) {
    return c.json({ error: adminErrorMessage(e) }, 500);
  }
  },
);

// ── Set account contracted-Enterprise entitlement flag ────────────────────────
// `enterprise_entitled` decouples a contracted cloud Enterprise customer's
// feature entitlements (SAML SSO, SCIM, RBAC, audit access) from the billing
// tier. Set this when an account signs an Enterprise agreement that is ALSO
// per-seat billed (a flat Enterprise fee plus per-seat billing): the
// per-seat Stripe webhook reconciliation will then populate
// billing_model/seats/credits from the subscription WITHOUT clobbering the
// enterprise identity entitlements (it leaves `tier` untouched when this flag
// is on). Clear it when the Enterprise term ends. For a pure-Enterprise (no
// per-seat) deal, `tier='enterprise'` alone is still sufficient; this flag is
// the additional, independent entitlement source for the hybrid case.
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/enterprise-entitlement',
    tags: ['admin'],
    summary: "Set the account's contracted-Enterprise entitlement flag",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ enabled: z.boolean() }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), enabled: z.boolean() }), 'Updated entitlement flag'),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const accountId = c.req.param('id');
      const actorUserId = c.get('userId') as string | undefined;
      const body = await readJsonObject(c);
      const enabled = body.enabled;
      if (typeof enabled !== 'boolean') {
        return c.json({ error: 'enabled must be a boolean' }, 400);
      }

      const { isEnterpriseEntitled } = await import('../../services/billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../../services/billing/services/account-write-owner');
      const before = await isEnterpriseEntitled(accountId);
      await applyAdminOverride(
        accountId,
        { enterpriseEntitled: enabled },
        { userId: actorUserId ?? null, action: 'admin.account.enterprise_entitlement.set' },
      );

      // The per-request entitlement read (SSO/SCIM gates) is uncached and sees
      // the change immediately; no tier-cache invalidation needed because
      // enterprise_entitled is resolved independently of the cached tier.
      try {
        const { recordAuditEvent } = await import('../../services/audit/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.enterprise_entitlement.set',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { enterprise_entitled: before },
          after: { enterprise_entitled: enabled },
          ip: requestClientIp(c),
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the entitlement change */
      }

      return c.json({ ok: true, enabled });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/trial',
    tags: ['admin'],
    summary: 'Grant or replace an account trial',
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              tier_key: z.string().min(1).max(50),
              seats: z.number().int().min(1),
              duration_days: z.number().int().min(1),
              note: z.string().max(2000).optional(),
              credit_grant: z.number().min(0).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.record(z.string(), z.any()), 'Trial granted'),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const accountId = c.req.param('id');
      const actorUserId = (c.get('userId') as string | undefined) ?? null;
      const body = c.req.valid('json') as {
        tier_key: string;
        seats: number;
        duration_days: number;
        note?: string;
        credit_grant?: number;
      };
      const { grantTrial, validateGrantTrialInput } = await import(
        '../../services/billing/services/trial-admin'
      );
      const input = {
        accountId,
        tierKey: body.tier_key,
        seats: body.seats,
        durationDays: body.duration_days,
        note: body.note ?? null,
        actorUserId,
        creditGrant: body.credit_grant,
      };
      const invalid = validateGrantTrialInput(input);
      if (invalid) return c.json({ error: invalid }, 400);

      const result = await grantTrial(input);

      try {
        const { recordAuditEvent } = await import('../../services/audit/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.trial.grant',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { trial: result.before },
          after: { trial: result.current, credit_granted: result.creditGranted },
          ip: requestClientIp(c),
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the grant */
      }

      return c.json({ ok: true, trial: result.current, credit_granted: result.creditGranted });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// ── Revoke an account trial ──────────────────────────────────────────────────
adminApp.openapi(
  createRoute({
    method: 'delete',
    path: '/api/accounts/{id}/trial',
    tags: ['admin'],
    summary: 'Revoke an active account trial',
    ...auth,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(z.record(z.string(), z.any()), 'Trial revoked'),
      400: json(z.record(z.string(), z.any()), 'No active trial'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const accountId = c.req.param('id');
      const actorUserId = (c.get('userId') as string | undefined) ?? null;
      const { revokeTrial } = await import('../../services/billing/services/trial-admin');
      let result;
      try {
        result = await revokeTrial(accountId);
      } catch (e: any) {
        return c.json({ error: adminErrorMessage(e) }, 400);
      }

      try {
        const { recordAuditEvent } = await import('../../services/audit/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.trial.revoke',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { trial: result.before },
          after: { trial: result.current },
          ip: requestClientIp(c),
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the revoke */
      }

      return c.json({ ok: true, trial: result.current });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// ── Set the account managed-models override ──────────────────────────────────
// `override: null` restores "the effective tier decides". true grants managed
// (Kortix-credential) models regardless of tier; false forces BYOK-only.
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/managed-models',
    tags: ['admin'],
    summary: "Set the account's managed-models override",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ override: z.boolean().nullable() }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), override: z.boolean().nullable() }),
        'Updated managed-models override',
      ),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const accountId = c.req.param('id');
      const actorUserId = (c.get('userId') as string | undefined) ?? null;
      const body = c.req.valid('json') as { override: boolean | null };

      const { getCreditAccount } = await import('../../services/billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../../services/billing/services/account-write-owner');
      const before = (await getCreditAccount(accountId))?.managedModelsOverride ?? null;
      // The chokepoint invalidates this account's billing cache — the one cache
      // the managed-models answer is served from on the gateway auth hot path.
      await applyAdminOverride(
        accountId,
        { managedModelsOverride: body.override },
        { userId: actorUserId, action: 'admin.account.managed_models.set' },
      );

      try {
        const { recordAuditEvent } = await import('../../services/audit/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.managed_models.set',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { managed_models_override: before },
          after: { managed_models_override: body.override },
          ip: requestClientIp(c),
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the change */
      }

      return c.json({ ok: true, override: body.override });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// ── Set the account enterprise-demo flag (admin-only) ────────────────────────
// The self-serve IAM toggle was retired: enterprise-demo is an operator
// decision now (see http/accounts/iam/enterprise-demo.ts). Same storage
// (credit_accounts.demo_enterprise), same entitlement effect.
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/enterprise-demo',
    tags: ['admin'],
    summary: "Set the account's enterprise-demo flag",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ enabled: z.boolean() }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), enabled: z.boolean() }), 'Updated demo flag'),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const accountId = c.req.param('id');
      const actorUserId = (c.get('userId') as string | undefined) ?? null;
      const body = c.req.valid('json') as { enabled: boolean };

      const { isDemoEnterprise } = await import('../../services/billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../../services/billing/services/account-write-owner');
      const before = await isDemoEnterprise(accountId);
      await applyAdminOverride(
        accountId,
        { demoEnterprise: body.enabled },
        { userId: actorUserId, action: 'admin.account.enterprise_demo.set' },
      );

      try {
        const { recordAuditEvent } = await import('../../services/audit/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.enterprise_demo.set',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { demo_enterprise: before },
          after: { demo_enterprise: body.enabled },
          ip: requestClientIp(c),
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the change */
      }

      return c.json({ ok: true, enabled: body.enabled });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// ── Mark an account's SSO domain verified (operator) ────────────────────────
// The self-serve path is DNS (`POST /accounts/:id/iam/sso/provider/verify-domain`).
// An operator can record the same fact after proving domain control another way
// (a support ticket from the domain's mail, a signed order form), or withdraw it.
// A verified domain makes the IdP's asserted emails trusted outside the account
// and turns on `enforce_sso`, so the change is audited on the account.
adminApp.openapi(
  createRoute({
    method: 'put',
    path: '/api/accounts/{id}/sso-domain-verification',
    tags: ['admin'],
    summary: "Mark the account's SSO primary domain verified or unverified",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ verified: z.boolean() }) } } },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), primary_domain: z.string(), domain_verified: z.boolean() }),
        'Updated domain verification',
      ),
      404: json(z.record(z.string(), z.any()), 'No SSO provider'),
      409: json(z.record(z.string(), z.any()), 'Domain verified by another account'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const accountId = c.req.param('id');
      const actorUserId = (c.get('userId') as string | undefined) ?? null;
      const body = c.req.valid('json') as { verified: boolean };
      const { domainVerifiedByOtherAccount, getSsoProvider, isSsoDomainVerified, setSsoDomainVerified } =
        await import('../../services/repositories/sso');
      const before = await getSsoProvider(accountId);
      if (!before) return c.json({ error: 'no SSO provider configured' }, 404);
      if (body.verified && (await domainVerifiedByOtherAccount(accountId, before.primaryDomain))) {
        return c.json(
          { error: `${before.primaryDomain} is already verified by another account`, code: 'sso_domain_claimed' },
          409,
        );
      }
      const after = await setSsoDomainVerified(accountId, body.verified);
      if (!after) return c.json({ error: 'no SSO provider configured' }, 404);
      try {
        const { recordAuditEvent } = await import('../../services/audit/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.sso_domain.set',
          resourceType: 'sso_provider',
          resourceId: after.ssoProviderId,
          before: { primary_domain: before.primaryDomain, domain_verified: isSsoDomainVerified(before) },
          after: { primary_domain: after.primaryDomain, domain_verified: isSsoDomainVerified(after), method: 'operator' },
          ip: requestClientIp(c),
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the change */
      }
      return c.json({ ok: true, primary_domain: after.primaryDomain, domain_verified: isSsoDomainVerified(after) });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// ── Set per-account entitlement overrides (the JSONB map) ────────────────────
// One route for every override an account can carry, each with an OPTIONAL
// EXPIRY — which the four single-purpose routes above cannot express at all
// (their columns have nowhere to put a date, so every grant they make is
// permanent until someone remembers to undo it).
//
// MERGE-PATCH semantics (RFC 7386, scoped to the known keys): a key present
// with an entry sets it, a key present with `null` deletes it, and a key that
// is absent is left exactly as it was. That is what makes the route safe to
// call from a form that only knows about one field.
adminApp.openapi(
  createRoute({
    method: 'put',
    path: '/api/accounts/{id}/overrides',
    tags: ['admin'],
    summary: "Merge-patch an account's entitlement overrides",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            // Deliberately loose HERE and strict in `validateOverridePatch`:
            // the domain rules (known keys, value type per key, ranges, ISO
            // expiry) are one pure function that unit tests can drive, not a
            // schema the tests would have to go through HTTP to exercise.
            schema: z.record(
              z.string(),
              z
                .object({
                  value: z.union([z.boolean(), z.number()]),
                  expires_at: z.string().optional(),
                })
                .nullable(),
            ),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), overrides: z.record(z.string(), z.any()) }),
        'Stored entitlement overrides',
      ),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const accountId = c.req.param('id');
      const actorUserId = (c.get('userId') as string | undefined) ?? null;
      const raw = await c.req.json().catch(() => null);

      const {
        legacyMirrorPatch,
        mergeOverridePatch,
        toStoredOverrides,
        validateOverridePatch,
      } = await import('../../services/billing/services/entitlement-overrides');
      const validated = validateOverridePatch(raw);
      if (!validated.ok) return c.json({ error: validated.error }, 400);

      const { getCreditAccount } = await import('../../services/billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../../services/billing/services/account-write-owner');
      const before = (await getCreditAccount(accountId))?.entitlementOverrides ?? {};
      const merged = mergeOverridePatch(before, validated.patch);

      await applyAdminOverride(
        accountId,
        {
          entitlementOverrides: toStoredOverrides(merged),
          // Mirror the four legacy columns for one release, so an API task
          // that predates this column still resolves a PERMANENT override the
          // same way. A timed entry clears its column instead — see
          // legacyMirrorPatch for why mirroring it would defeat the expiry.
          ...legacyMirrorPatch(validated.patch),
        },
        { userId: actorUserId, action: 'admin.account.overrides.set' },
      );

      // Two caches read these values: the unified billing cache (invalidated by
      // applyAdminOverride) and the legacy per-process limit cache.
      const { clearAccountLimitCache } = await import('../../services/billing/account-limits');
      clearAccountLimitCache();

      const stored = (await getCreditAccount(accountId))?.entitlementOverrides ?? {};
      try {
        const { recordAuditEvent } = await import('../../services/audit/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.overrides.set',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { entitlement_overrides: before },
          after: { entitlement_overrides: stored },
          ip: requestClientIp(c),
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the override change */
      }

      return c.json({ ok: true, overrides: stored });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// ── Provider load-balancing: split weights ───────────────────────────────────
// GET current weights + the allowed providers. Weights drive selectProvider()
// (services/platform/services/provider-balancer); unset/zero -> first allowed provider.
adminApp.openapi(
  createRoute({
    method: 'get', path: '/api/provider-distribution', tags: ['admin'],
    summary: 'Get provider split weights', ...auth,
    responses: { 200: json(z.record(z.string(), z.any()), 'weights'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const { config } = await import('../../lib/config');
    const weights = await readProviderDistribution();
    return c.json({ allowed: config.ALLOWED_SANDBOX_PROVIDERS, default: config.getDefaultProvider(), weights: weights ?? {} });
  },
);

// PUT new weights ({ platinum: 70, daytona: 30 }). Filtered to allowed providers.
adminApp.openapi(
  createRoute({
    method: 'put', path: '/api/provider-distribution', tags: ['admin'],
    summary: 'Set provider split weights', ...auth,
    request: { body: { content: { 'application/json': { schema: z.record(z.string(), z.number()) } } } },
    responses: { 200: json(z.record(z.string(), z.any()), 'ok'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const body = await readJsonObject(c);
    const src = (
      typeof body.weights === 'object' && body.weights !== null ? body.weights : body
    ) as Record<string, unknown>;
    const { config } = await import('../../lib/config');
    const weights: Record<string, number> = {};
    for (const p of config.ALLOWED_SANDBOX_PROVIDERS) {
      const w = Number(src[p]); if (Number.isFinite(w) && w >= 0) weights[p] = w;
    }
    const { invalidateProviderDistributionCache } = await import('../../services/platform/services/provider-balancer');
    await saveProviderDistribution(weights);
    invalidateProviderDistributionCache();
    return c.json({ ok: true, weights });
  },
);

// ── Provider failover (one-shot, on session init; DB-backed, not env) ────────
// GET current failover toggle. When ON, a provider that fails to provision a
// session at birth hands off once to the next allowed provider. Default OFF.
adminApp.openapi(
  createRoute({
    method: 'get', path: '/api/provider-fallback', tags: ['admin'],
    summary: 'Get provider failover config', ...auth,
    responses: { 200: json(z.record(z.string(), z.any()), 'config'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const { providerFallbackSetting } = await import('../../services/platform/services/runtime-settings');
    return c.json(providerFallbackSetting());
  },
);

// PUT failover toggle ({ enabled }).
adminApp.openapi(
  createRoute({
    method: 'put', path: '/api/provider-fallback', tags: ['admin'],
    summary: 'Set provider failover config', ...auth,
    request: { body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } } },
    responses: { 200: json(z.record(z.string(), z.any()), 'ok'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const body = await readJsonObject(c);
    const value = { enabled: body.enabled === true };
    const { invalidateRuntimeSettings, refreshRuntimeSettings } = await import('../../services/platform/services/runtime-settings');
    await saveProviderFallback(value);
    invalidateRuntimeSettings();
    await refreshRuntimeSettings();
    return c.json({ ok: true, ...value });
  },
);

// ── Sandboxes: list all with provider + a per-provider count ─────────────────
adminApp.openapi(
  createRoute({
    method: 'get', path: '/api/sandboxes', tags: ['admin'],
    summary: 'List sandboxes with provider type', ...auth,
    request: { query: z.object({ limit: z.string().optional(), provider: z.string().optional(), status: z.string().optional() }) },
    responses: { 200: json(z.record(z.string(), z.any()), 'sandboxes'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const limit = Math.min(Number(c.req.query('limit') || 200), 1000);
    const { rows, byProvider } = await listAdminSandboxes({
      limit,
      provider: c.req.query('provider'),
      status: c.req.query('status'),
    });
    return c.json({ sandboxes: rows, byProvider });
  },
);

// ── Migrate a session's sandbox to another provider ──────────────────────────
// Reprovisions on the target via the shared re-provision path (env/git/secrets
// rebuild statelessly), then async-removes the old provider's box.
adminApp.openapi(
  createRoute({
    method: 'post', path: '/api/sandboxes/{sessionId}/migrate', tags: ['admin'],
    summary: 'Migrate sandbox to another provider', ...auth,
    request: { params: z.object({ sessionId: z.string() }), body: { content: { 'application/json': { schema: z.object({ targetProvider: z.string() }) } } } },
    responses: { 200: json(z.record(z.string(), z.any()), 'ok'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const sessionId = c.req.param('sessionId');
    const body = await readJsonObject(c);
    const target = String(body.targetProvider || '');
    const { config } = await import('../../lib/config');
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(target)) return c.json({ error: 'invalid targetProvider' }, 400);
    const sb = await findSessionSandbox(sessionId);
    if (!sb) return c.json({ error: 'sandbox not found' }, 404);
    if (sb.provider === target) return c.json({ error: 'already on target provider' }, 400);
    const sess = await findProjectSession(sessionId);
    if (!sess) return c.json({ error: 'session not found' }, 404);
    const proj = await findProject(sess.projectId);
    if (!proj) return c.json({ error: 'project not found' }, 404);
    const oldProvider = sb.provider;
    if (sb.externalId) {
      return c.json({
        error: 'A materialized session sandbox cannot be replaced or migrated in place because it may contain uncommitted data.',
        code: 'SESSION_RUNTIME_IDENTITY_IMMUTABLE',
        sessionId,
        provider: oldProvider,
        externalId: sb.externalId,
      }, 409);
    }
    // A placeholder that never acquired an external provider object contains no
    // user data and can safely be reassigned.
    await deleteSessionSandbox(sessionId);
    const { allocateRuntimeOnOpen } = await import('../../services/sessions/open/shared');
    await allocateRuntimeOnOpen(
      { row: proj as any, userId: sess.createdBy ?? '' },
      { sandboxProvider: target, baseRef: sess.baseRef, agentName: sess.agentName },
      sess.projectId, sessionId,
    );
    const { recordProviderEvent } = await import('../../services/platform/services/provider-events');
    recordProviderEvent({
      provider: target, kind: 'migrate', outcome: 'ok', fromProvider: oldProvider,
      sessionId, accountId: (proj as any).accountId ?? null,
    });
    return c.json({ ok: true, sessionId, from: oldProvider, to: target });
  },
);

// ── Provider analytics ───────────────────────────────────────────────────────
// Aggregates the append-only provider_events log into per-provider performance:
// success rate, provision latency (p50/p95), where the time goes (phase marks),
// and daily time-series. Admin-only + low volume, so we pull a bounded window
// and aggregate in JS rather than push percentiles into SQL.
adminApp.openapi(
  createRoute({
    method: 'get', path: '/api/provider-analytics', tags: ['admin'],
    summary: 'Provider performance analytics', ...auth,
    request: { query: z.object({ days: z.string().optional() }) },
    responses: { 200: json(z.record(z.string(), z.any()), 'analytics'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const days = Math.min(Math.max(Number(c.req.query('days') || 7), 1), 90);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const rows = await listProviderEventsSince(cutoff);
    return c.json(summarizeProviderAnalytics(rows, days));
  },
);

// ── Act-as impersonation ─────────────────────────────────────────────────────
// "Open this customer's account" for support and debugging. The grant is a ROW
// (kortix.impersonation_grants), never a token: the client only ever holds an
// id, and ownership, expiry, revocation and the operator's CURRENT platform
// role are re-read on every request that presents it (services/iam/impersonation.ts +
// http/middleware/impersonation.ts). Revocation is therefore instant, and demoting
// an operator kills their live sessions mid-flight.
//
// These three routes are themselves unreachable from inside an impersonated
// session — /v1/admin/* is on the forbidden list — so a session can neither
// mint a second grant nor extend itself.

// Mint a grant. TTL is capped at one hour and written by the server; the
// request cannot ask for longer.
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/impersonate',
    tags: ['admin'],
    summary: 'Start acting as an account',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              account_id: z.string(),
              reason: z.string().max(500).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          grant_id: z.string(),
          account_id: z.string(),
          expires_at: z.string(),
        }),
        'Impersonation grant',
      ),
      400: json(z.record(z.string(), z.any()), 'Bad request'),
      404: json(z.record(z.string(), z.any()), 'Account not found'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const adminUserId = c.get('userId') as string;
      const body = await c.req.json().catch(() => null);
      const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
      const reasonRaw = typeof body?.reason === 'string' ? body.reason.trim() : '';
      const reason = reasonRaw ? reasonRaw.slice(0, 500) : null;
      if (!isUuid(accountId)) {
        return c.json({ error: 'account_id must be a uuid' }, 400);
      }

      // Refuse a grant on an account that does not exist. A row pointing at a
      // typo'd uuid would sit in the table looking like a real support session.
      const account = await findAccountName(accountId);
      if (!account) return c.json({ error: 'account not found' }, 404);

      const { createImpersonationGrant, impersonationExpiryFrom, IMPERSONATION_START_ACTION } =
        await import('../../services/iam/impersonation');
      const expiresAt = impersonationExpiryFrom(new Date());
      const grant = await createImpersonationGrant({
        adminUserId,
        targetAccountId: accountId,
        reason,
        expiresAt,
      });

      // Audited against the TARGET account, not ours: the customer's own audit
      // log (and any audit webhook they have configured) is where "an operator
      // entered your account" has to appear. `actorUserId` is the real admin.
      const { recordAuditEvent } = await import('../../services/audit/audit');
      await recordAuditEvent({
        accountId,
        actorUserId: adminUserId,
        actorType: 'human',
        action: IMPERSONATION_START_ACTION,
        resourceType: 'account',
        resourceId: accountId,
        metadata: {
          grant_id: grant.id,
          impersonator_user_id: adminUserId,
          target_account_id: accountId,
          reason,
          expires_at: expiresAt.toISOString(),
        },
        ip: requestClientIp(c),
        userAgent: c.req.header('user-agent') || null,
      });

      return c.json({
        grant_id: grant.id,
        account_id: accountId,
        account_name: account.name ?? null,
        expires_at: expiresAt.toISOString(),
      });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// Stop acting. Scoped to the caller's own grants — a non-owner gets the same
// 404 as a nonexistent id, so this is not an enumeration oracle either.
adminApp.openapi(
  createRoute({
    method: 'delete',
    path: '/api/impersonate/{grantId}',
    tags: ['admin'],
    summary: 'Stop acting as an account',
    ...auth,
    request: { params: z.object({ grantId: z.string() }) },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), grant_id: z.string(), revoked_at: z.string().nullable() }),
        'Revoked grant',
      ),
      404: json(z.record(z.string(), z.any()), 'Grant not found'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const adminUserId = c.get('userId') as string;
      const grantId = c.req.param('grantId');
      const { revokeImpersonationGrant, IMPERSONATION_STOP_ACTION } = await import(
        '../../services/iam/impersonation'
      );
      const grant = await revokeImpersonationGrant({ grantId, adminUserId });
      if (!grant) return c.json({ error: 'grant not found' }, 404);

      const { recordAuditEvent } = await import('../../services/audit/audit');
      await recordAuditEvent({
        accountId: grant.targetAccountId,
        actorUserId: adminUserId,
        actorType: 'human',
        action: IMPERSONATION_STOP_ACTION,
        resourceType: 'account',
        resourceId: grant.targetAccountId,
        metadata: {
          grant_id: grant.id,
          impersonator_user_id: adminUserId,
          target_account_id: grant.targetAccountId,
        },
        ip: requestClientIp(c),
        userAgent: c.req.header('user-agent') || null,
      });

      return c.json({
        ok: true,
        grant_id: grant.id,
        revoked_at: grant.revokedAt ? grant.revokedAt.toISOString() : null,
      });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// The caller's live grants. Lets a console that lost its sessionStorage (new
// tab, cleared storage, another device) find the session it is still inside
// and exit it, instead of waiting out the hour.
adminApp.openapi(
  createRoute({
    method: 'get',
    path: '/api/impersonate/active',
    tags: ['admin'],
    summary: 'List the caller-held impersonation grants',
    ...auth,
    responses: {
      200: json(
        z.object({ grants: z.array(z.record(z.string(), z.any())) }),
        'Active grants',
      ),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    try {
      const adminUserId = c.get('userId') as string;
      const { listActiveImpersonationGrants } = await import('../../services/iam/impersonation');
      const grants = await listActiveImpersonationGrants(adminUserId);
      const names = new Map<string, string | null>();
      if (grants.length > 0) {
        const rows = await listAccountNames(grants.map((g) => g.targetAccountId));
        for (const row of rows) names.set(row.accountId, row.name ?? null);
      }
      return c.json({
        grants: grants.map((g) => ({
          grant_id: g.id,
          account_id: g.targetAccountId,
          account_name: names.get(g.targetAccountId) ?? null,
          expires_at: g.expiresAt.toISOString(),
        })),
      });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);
