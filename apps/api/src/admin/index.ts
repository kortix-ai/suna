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
import type { AppEnv } from '../types';
import { supabaseAuth } from '../middleware/auth';
import { requestClientIp } from '../middleware/client-ip';
import { requireAdmin } from '../middleware/require-admin';
import { makeOpenApiApp, json, errors, auth } from '../openapi';
import { analyticsApp } from './analytics';
import { isUuid } from '../shared/validate';
import { isoValue } from '../shared/cost-values';
import { readJsonObject } from '../shared/http-body';
import { errorSqlstate } from '../shared/error-cause';
import { logger } from '../lib/logger';
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
} from './queries';
import { summarizeProviderAnalytics } from './provider-analytics';

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
 * in `apps/api/src/admin/analytics.ts` (#7770 / KRTX-423).
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
    const { parseAdminAccountsListQuery } = await import('./accounts-query');
    const { accountDisplayName } = await import('../accounts/core/app');
    // PURE resolver — no I/O, no cache, no clock of its own. It runs over the
    // row this query already selects, so the `plan` block below costs zero
    // extra queries (no N+1) and reports the same plan every server gate
    // enforces for that account.
    const { resolveBillingFromRow } = await import('../billing/services/resolve-billing');
    const { planMonthlyUsd } = await import('../billing/services/tiers');

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
      // The plan the account BEHAVES as: an active admin trial overlays the
      // stored `tier`, and that is what every
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
        // RESOLVED plan, named the way the product names plans (Free / Credits /
        // Enterprise). The console renders this instead of mapping
        // the raw key onto a hand-maintained label table of its own.
        plan: {
          key: resolved.plan.key,
          family: resolved.plan.family,
          label: resolved.display.label,
          sublabel: resolved.display.sublabel,
          status: resolved.plan.status,
          monthlyUsd: resolved.plan.key === 'credits' ? planMonthlyUsd(r) : null,
        },
        paymentStatus: r.paymentStatus ?? null,
        provider: r.provider ?? null,
        planType: r.planType ?? null,
        stripeSubscriptionId: r.stripeSubscriptionId ?? null,
        trial: {
          status: r.trialStatus ?? 'none',
          tier: r.trialTier ?? null,
          startedAt: isoValue(r.trialStartedAt),
          endsAt: isoValue(r.trialEndsAt),
          note: r.trialNote ?? null,
        },
        // The active Enterprise contract. Null on every other account; an
        // Enterprise account with null here has no contract on file.
        contract: r.contractId
          ? {
              id: r.contractId,
              licenseUsd: Number(r.contractLicenseUsd),
              creditsUsd: Number(r.contractCreditsUsd),
              collection: r.contractCollection,
              endsAt: isoValue(r.contractEndsAt),
              autoRenews: r.contractAutoRenews ?? false,
            }
          : null,
        // Set while SSO/SCIM stay on after an Enterprise trial ended.
        graceEndsAt: resolved.grace?.endsAt ?? null,
        // The stored override map, exactly as PUT /accounts/{id}/overrides left
        // it. Expiry is NOT applied here — the console shows an operator what
        // is on the row, including entries that have lapsed; `resolved` above
        // is what the gates enforce.
        entitlementOverrides: r.entitlementOverrides ?? {},
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
    const { accountRoleFor, countAccountOwners } = await import('../iam/read-models');
    const assignmentsModule = await import('../iam/assignments');
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
      const { recordAuditEvent } = await import('../shared/audit');
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
    const { parseAdminProjectsListQuery } = await import('./projects-query');

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

// ── Set a project's feature flag (operator) ─────────────────────────────────
// The operator lever for internal-only flags (`apps`): Kortix turns
// them on per project on request. `PATCH /v1/projects/:id/features` refuses
// those flags for everyone but a platform operator, and this route needs no
// project membership. Any flag key works here. Audited on the project.
adminApp.openapi(
  createRoute({
    method: 'put',
    path: '/api/projects/{id}/features',
    tags: ['admin'],
    summary: "Set or clear a project's feature flag (operator)",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              feature: z.string().openapi({ description: 'Flag key, for example `apps`.' }),
              enabled: z.boolean().nullable().openapi({ description: '`true`/`false` sets the override; `null` clears it.' }),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          project_id: z.string(),
          feature: z.string(),
          override: z.boolean().nullable(),
          enabled: z.boolean().openapi({ description: 'Effective state after the write.' }),
        }),
        'Updated flag',
      ),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { feature, enabled } = c.req.valid('json');
    const { isFeatureFlagKey, resolveFeatureFlag } = await import('../feature-flags/registry');
    if (!isFeatureFlagKey(feature)) return c.json({ error: `Unknown feature flag '${feature}'` }, 400);
    if (!isUuid(projectId)) return c.json({ error: 'Not found' }, 404);
    const before = await findProject(projectId);
    if (!before || before.status === 'archived') return c.json({ error: 'Not found' }, 404);
    const { writeProjectFeatureFlag } = await import('../feature-flags/write');
    const row = await writeProjectFeatureFlag(projectId, feature, enabled);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const override = (row.metadata as { experimental?: Record<string, unknown> } | null)?.experimental?.[feature];
    const { recordAuditEvent } = await import('../shared/audit');
    await recordAuditEvent({
      accountId: row.accountId,
      projectId,
      actorUserId: c.get('userId') ?? null,
      action: 'admin.project.feature.set',
      resourceType: 'project',
      resourceId: projectId,
      before: { [feature]: (before.metadata as { experimental?: Record<string, unknown> } | null)?.experimental?.[feature] ?? null },
      after: { [feature]: enabled },
      ip: requestClientIp(c),
      userAgent: c.req.header('user-agent') || null,
    }).catch(() => {
      /* audit is best-effort, as on the other admin writes */
    });
    return c.json(
      {
        project_id: projectId,
        feature,
        override: typeof override === 'boolean' ? override : null,
        enabled: resolveFeatureFlag(row.metadata, feature),
      },
      200,
    );
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
    const { getCreditAccount } = await import('../billing/repositories/credit-accounts');
    const account = await getCreditAccount(accountId);
    const subscriptionId = account?.stripeSubscriptionId ?? null;
    if (!subscriptionId) return c.json({ subscription: null });
    const { getStripe } = await import('../shared/stripe');
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
  const { wallet } = await import('../billing/wallet');
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

    const { wallet } = await import('../billing/wallet');
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

    const { wallet } = await import('../billing/wallet');
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

// ── Set plan tier (Free or Credits) ─────────────────────────────────────────
// The audited way to reassign a self-serve plan by hand (a comp, a botched
// migration). Enterprise goes through the contract routes below. Upserts the
// credit_accounts row and clears the tier cache so the change applies at once.
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/tier',
    tags: ['admin'],
    summary: "Set an account's plan tier (Free or Credits)",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ tier: z.string(), monthly_usd: z.number().min(0).optional() }),
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

    const { isValidTier } = await import('../billing/services/tiers');
    if (!isValidTier(tier)) return c.json({ error: `unknown tier "${tier}"` }, 400);

    // Enterprise has one write path: a contract, so its terms, credit pool and
    // end date are on file (billing/services/enterprise-contracts.ts).
    if (tier === 'enterprise') {
      return c.json(
        { error: "Enterprise is set by a contract: POST /api/accounts/{id}/enterprise-contract" },
        400,
      );
    }
    const { getActiveContract } = await import('../billing/services/enterprise-contracts');
    if (await getActiveContract(accountId)) {
      return c.json({ error: 'the account has an active Enterprise contract; end it first' }, 409);
    }

    // `monthly_usd` is the plan amount of a credits plan. Omit it to leave the
    // amount unchanged.
    const monthlyRaw = body.monthly_usd;
    const monthlyUsd = monthlyRaw === undefined || monthlyRaw === null ? undefined : Number(monthlyRaw);
    if (monthlyUsd !== undefined && (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || monthlyUsd > 1_000_000)) {
      return c.json({ error: 'monthly_usd must be a number from 0 to 1,000,000' }, 400);
    }

    const { getSubscriptionInfo } = await import('../billing/repositories/credit-accounts');
    const { applyAdminOverride } = await import('../billing/services/account-write-owner');
    const before = await getSubscriptionInfo(accountId);
    // `tier` is provider-owned everywhere else, and ADMIN_ASSIGNABLE here: an
    // operator reassigning a plan by hand is a real support operation.
    await applyAdminOverride(
      accountId,
      {
        tier,
        ...(monthlyUsd !== undefined ? { planMonthlyUsd: String(monthlyUsd) } : {}),
      },
      { userId: actorUserId ?? null, action: 'admin.account.tier.set' },
    );

    try {
      const { recordAuditEvent } = await import('../shared/audit');
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

// ── Grant or extend a trial ──────────────────────────────────────────────────
// A trial is a dated grant of a plan ('credits' or 'enterprise') with one
// expiring credit grant (billing/services/trial-admin.ts). Re-granting the same
// plan moves the end date.
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
        duration_days: number;
        note?: string;
        credit_grant?: number;
      };
      const { grantTrial, validateGrantTrialInput } = await import(
        '../billing/services/trial-admin'
      );
      const input = {
        accountId,
        tierKey: body.tier_key,
        durationDays: body.duration_days,
        note: body.note ?? null,
        actorUserId,
        creditGrant: body.credit_grant,
      };
      const invalid = validateGrantTrialInput(input);
      if (invalid) return c.json({ error: invalid }, 400);

      const result = await grantTrial(input);

      try {
        const { recordAuditEvent } = await import('../shared/audit');
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
      const { revokeTrial } = await import('../billing/services/trial-admin');
      let result;
      try {
        result = await revokeTrial(accountId);
      } catch (e: any) {
        return c.json({ error: adminErrorMessage(e) }, 400);
      }

      try {
        const { recordAuditEvent } = await import('../shared/audit');
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

// ── Enterprise contracts ─────────────────────────────────────────────────────
// The one way onto Enterprise: an annual license plus a prepaid credit pool
// (billing/services/enterprise-contracts.ts). `checkout` makes an offer the
// account's billing managers accept in the app; `invoice` bills through a
// Stripe invoice; `manual` records a contract paid outside Stripe.
const ContractBody = z.object({
  license_usd: z.number().min(0),
  credits_usd: z.number().min(0),
  term_months: z.number().int().min(1).optional(),
  collection: z.enum(['checkout', 'invoice', 'manual']),
  note: z.string().max(2000).optional(),
});

type ContractRecord = typeof import('@kortix/db').enterpriseContracts.$inferSelect;

function serializeContract(row: ContractRecord) {
  return {
    id: row.id,
    status: row.status,
    licenseUsd: Number(row.licenseUsd),
    creditsUsd: Number(row.creditsUsd),
    termMonths: row.termMonths,
    collection: row.collection,
    startsAt: isoValue(row.startsAt),
    endsAt: isoValue(row.endsAt),
    autoRenews: row.autoRenews,
    stripeSubscriptionId: row.stripeSubscriptionId ?? null,
    note: row.note ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: isoValue(row.createdAt),
    endedAt: isoValue(row.endedAt),
  };
}

async function auditContract(input: {
  accountId: string;
  actorUserId: string | null;
  action: string;
  contract: ReturnType<typeof serializeContract>;
  ip: string | null;
  userAgent: string | null;
}) {
  try {
    const { recordAuditEvent } = await import('../shared/audit');
    await recordAuditEvent({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      action: input.action,
      resourceType: 'enterprise_contract',
      resourceId: input.contract.id,
      after: input.contract,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  } catch {
    /* audit is best-effort — never block the contract change */
  }
}

/** The status a refused contract operation answers with: its own 400/404/409, else 500. */
function contractFailure(e: unknown): { status: 400 | 404 | 409 | 500; error: string } {
  const status = e instanceof Error && 'statusCode' in e ? (e as { statusCode: number }).statusCode : 500;
  return {
    status: status === 400 || status === 404 || status === 409 ? status : 500,
    error: adminErrorMessage(e),
  };
}

const ContractEnvelope = z.object({ contract: z.record(z.string(), z.any()) });
const ErrorBody = z.object({ error: z.string() });
const AccountIdParam = z.object({ id: z.string() });

adminApp.openapi(
  createRoute({
    method: 'get',
    path: '/api/accounts/{id}/enterprise-contracts',
    tags: ['admin'],
    summary: "List an account's Enterprise contracts, newest first",
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ contracts: z.array(z.record(z.string(), z.any())) }), 'Contracts'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { listContracts } = await import('../billing/services/enterprise-contracts');
    return c.json({ contracts: (await listContracts(id)).map(serializeContract) }, 200);
  },
);

adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/enterprise-contract',
    tags: ['admin'],
    summary: 'Create an Enterprise contract (offer, invoice, or manual)',
    ...auth,
    request: {
      params: AccountIdParam,
      body: { content: { 'application/json': { schema: ContractBody } } },
    },
    responses: {
      200: json(ContractEnvelope, 'The contract'),
      400: json(ErrorBody, 'Bad request'),
      404: json(ErrorBody, 'Not found'),
      409: json(ErrorBody, 'Conflict'),
      500: json(ErrorBody, 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const { id: accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const actorUserId = c.get('userId') ?? null;
    try {
      const { createContract } = await import('../billing/services/enterprise-contracts');
      const contract = serializeContract(
        await createContract({
          accountId,
          licenseUsd: body.license_usd,
          creditsUsd: body.credits_usd,
          termMonths: body.term_months,
          collection: body.collection,
          note: body.note ?? null,
          actorUserId,
        }),
      );
      await auditContract({
        accountId,
        actorUserId,
        action: 'admin.account.enterprise_contract.create',
        contract,
        ip: requestClientIp(c),
        userAgent: c.req.header('user-agent') || null,
      });
      return c.json({ contract }, 200);
    } catch (e) {
      const failure = contractFailure(e);
      return c.json({ error: failure.error }, failure.status);
    }
  },
);

adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/enterprise-contract/checkout-link',
    tags: ['admin'],
    summary: 'A fresh Stripe Checkout link for the open offer (valid up to 24 h)',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ checkout_url: z.string(), contract_id: z.string() }), 'Checkout link'),
      400: json(ErrorBody, 'Bad request'),
      404: json(ErrorBody, 'No open offer'),
      409: json(ErrorBody, 'Conflict'),
      500: json(ErrorBody, 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const { id: accountId } = c.req.valid('param');
    try {
      const { billingPaneUrl } = await import('../billing/services/owner-alerts');
      const billingUrl = billingPaneUrl(accountId);
      const { createOfferCheckout } = await import('../billing/services/enterprise-contracts');
      return c.json(await createOfferCheckout({ accountId, successUrl: billingUrl, cancelUrl: billingUrl }), 200);
    } catch (e) {
      const failure = contractFailure(e);
      return c.json({ error: failure.error }, failure.status);
    }
  },
);

adminApp.openapi(
  createRoute({
    method: 'delete',
    path: '/api/accounts/{id}/enterprise-offer',
    tags: ['admin'],
    summary: 'Withdraw the open Enterprise offer',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(ContractEnvelope, 'The withdrawn offer'),
      400: json(ErrorBody, 'Bad request'),
      404: json(ErrorBody, 'No open offer'),
      409: json(ErrorBody, 'Conflict'),
      500: json(ErrorBody, 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const { id: accountId } = c.req.valid('param');
    const actorUserId = c.get('userId') ?? null;
    try {
      const { withdrawOffer } = await import('../billing/services/enterprise-contracts');
      const contract = serializeContract(await withdrawOffer(accountId, actorUserId));
      await auditContract({
        accountId,
        actorUserId,
        action: 'admin.account.enterprise_offer.withdraw',
        contract,
        ip: requestClientIp(c),
        userAgent: c.req.header('user-agent') || null,
      });
      return c.json({ contract }, 200);
    } catch (e) {
      const failure = contractFailure(e);
      return c.json({ error: failure.error }, failure.status);
    }
  },
);

adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/enterprise-contract/end',
    tags: ['admin'],
    summary: "End the account's active Enterprise contract now",
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(ContractEnvelope, 'The ended contract'),
      400: json(ErrorBody, 'Bad request'),
      404: json(ErrorBody, 'No active contract'),
      409: json(ErrorBody, 'Conflict'),
      500: json(ErrorBody, 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const { id: accountId } = c.req.valid('param');
    const actorUserId = c.get('userId') ?? null;
    try {
      const { endContract, getActiveContract } = await import('../billing/services/enterprise-contracts');
      const active = await getActiveContract(accountId);
      if (!active) return c.json({ error: 'the account has no active Enterprise contract' }, 404);
      const contract = serializeContract(await endContract(active.id, 'operator', actorUserId));
      await auditContract({
        accountId,
        actorUserId,
        action: 'admin.account.enterprise_contract.end',
        contract,
        ip: requestClientIp(c),
        userAgent: c.req.header('user-agent') || null,
      });
      return c.json({ contract }, 200);
    } catch (e) {
      const failure = contractFailure(e);
      return c.json({ error: failure.error }, failure.status);
    }
  },
);

// ── Mark an account's SSO domain verified (operator) ────────────────────────
// The self-serve path is DNS (`POST /accounts/:id/iam/sso/provider/verify-domain`).
// An operator can record the same fact after proving domain control another way
// (a support ticket from the domain's mail, a signed order form), or withdraw it.
// A verified domain makes the IdP's asserted emails trusted outside the account
// and turns on `enforce_sso`, which signs out every member it refuses, so the
// change is audited on the account. Unverifying restores no sign-in.
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
      const {
        domainVerifiedByOtherAccount,
        getSsoProvider,
        isSsoDomainVerified,
        setSsoDomainVerified,
        signOutNonSsoMembers,
      } = await import('../repositories/sso');
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
      // With `enforce_sso` on, verifying turns enforcement on: end the sign-ins
      // the gate now refuses. Ends nothing otherwise; repeating the request
      // retries a failed run. null = it failed, after the change was saved.
      // Unverifying (break-glass) ends nothing, so it never runs the query.
      const revokedSessions = body.verified
        ? await signOutNonSsoMembers(accountId, actorUserId).catch((err: unknown) => {
            logger.error('[admin] could not end the sign-ins SSO only refuses', { accountId, error: String(err) });
            return null;
          })
        : 0;
      try {
        const { recordAuditEvent } = await import('../shared/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.sso_domain.set',
          resourceType: 'sso_provider',
          resourceId: after.ssoProviderId,
          before: { primary_domain: before.primaryDomain, domain_verified: isSsoDomainVerified(before) },
          after: {
            primary_domain: after.primaryDomain,
            domain_verified: isSsoDomainVerified(after),
            method: 'operator',
            revoked_sessions: revokedSessions,
          },
          ip: requestClientIp(c),
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the change */
      }
      if (revokedSessions === null) {
        return c.json(
          {
            error: 'Could not sign out the members who signed in without SSO. Repeat this request to retry.',
            code: 'sso_sign_out_failed',
          },
          500,
        );
      }
      return c.json({ ok: true, primary_domain: after.primaryDomain, domain_verified: isSsoDomainVerified(after) });
    } catch (e: any) {
      return c.json({ error: adminErrorMessage(e) }, 500);
    }
  },
);

// ── Set per-account entitlement overrides (the JSONB map) ────────────────────
// The one exception mechanism (.agents/skills/billing/references/plans-and-access.md):
// a per-feature boolean (sso, scim, rbac, auditAccess, branding, managedModels),
// each with an OPTIONAL EXPIRY.
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
                  value: z.boolean(),
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
        mergeOverridePatch,
        toStoredOverrides,
        validateOverridePatch,
      } = await import('../billing/services/entitlement-overrides');
      const validated = validateOverridePatch(raw);
      if (!validated.ok) return c.json({ error: validated.error }, 400);

      const { getCreditAccount } = await import('../billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../billing/services/account-write-owner');
      const before = (await getCreditAccount(accountId))?.entitlementOverrides ?? {};
      const merged = mergeOverridePatch(before, validated.patch);

      await applyAdminOverride(
        accountId,
        { entitlementOverrides: toStoredOverrides(merged) },
        { userId: actorUserId, action: 'admin.account.overrides.set' },
      );

      // Two caches read these values: the unified billing cache (invalidated by
      // applyAdminOverride) and the legacy per-process limit cache.
      const { clearAccountLimitCache } = await import('../shared/account-limits');
      clearAccountLimitCache();

      const stored = (await getCreditAccount(accountId))?.entitlementOverrides ?? {};
      try {
        const { recordAuditEvent } = await import('../shared/audit');
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
// (platform/services/provider-balancer); unset/zero -> first allowed provider.
adminApp.openapi(
  createRoute({
    method: 'get', path: '/api/provider-distribution', tags: ['admin'],
    summary: 'Get provider split weights', ...auth,
    responses: { 200: json(z.record(z.string(), z.any()), 'weights'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const { config } = await import('../config');
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
    const { config } = await import('../config');
    const weights: Record<string, number> = {};
    for (const p of config.ALLOWED_SANDBOX_PROVIDERS) {
      const w = Number(src[p]); if (Number.isFinite(w) && w >= 0) weights[p] = w;
    }
    const { invalidateProviderDistributionCache } = await import('../platform/services/provider-balancer');
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
    const { providerFallbackSetting } = await import('../platform/services/runtime-settings');
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
    const { invalidateRuntimeSettings, refreshRuntimeSettings } = await import('../platform/services/runtime-settings');
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
    const { config } = await import('../config');
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
    const { allocateRuntimeOnOpen } = await import('../projects/session-open');
    await allocateRuntimeOnOpen(
      { row: proj as any, userId: sess.createdBy ?? '' },
      { sandboxProvider: target, baseRef: sess.baseRef, agentName: sess.agentName },
      sess.projectId, sessionId,
    );
    const { recordProviderEvent } = await import('../platform/services/provider-events');
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
// role are re-read on every request that presents it (shared/impersonation.ts +
// middleware/impersonation.ts). Revocation is therefore instant, and demoting
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
        await import('../shared/impersonation');
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
      const { recordAuditEvent } = await import('../shared/audit');
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
        '../shared/impersonation'
      );
      const grant = await revokeImpersonationGrant({ grantId, adminUserId });
      if (!grant) return c.json({ error: 'grant not found' }, 404);

      const { recordAuditEvent } = await import('../shared/audit');
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
      const { listActiveImpersonationGrants } = await import('../shared/impersonation');
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
