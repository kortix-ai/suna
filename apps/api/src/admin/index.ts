/**
 * Admin console API (revived for the current backend).
 *
 * Mounted at /v1/admin, gated by supabaseAuth + requireAdmin (platform role
 * 'admin' | 'super_admin' in kortix.platform_user_roles). Backs the web admin
 * pages under apps/web/src/app/admin/.
 *
 * Scope (v1): the safe accounts console — list accounts (filterable by tier,
 * payment status, paid-only, and subscription presence), account members,
 * credit ledger, and grant/debit credits (reusing the billing grantCredits
 * service). Stripe customer id/email are still returned as null (no join yet);
 * the legacy env/exec/schema endpoints are intentionally NOT restored.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { supabaseAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/require-admin';
import { makeOpenApiApp, json, errors, auth } from '../openapi';
import { MAX_ACCOUNT_SESSION_LIMIT, setAccountSessionLimit } from './account-session-limit';
import { analyticsApp } from './analytics';

export const adminApp = makeOpenApiApp<AppEnv>();

// `account_id` reaches Postgres as a `uuid`, where a malformed value is a
// 22P02 cast error long before any guard runs — a 500 on input the caller
// controls. Shape-check first so a typo is a clean 400.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  try {
    const { db } = await import('../shared/db');
    const { accounts, creditAccounts } = await import('@kortix/db');
    const { and, asc, desc, eq, ilike, gte, lte, inArray, notInArray, isNotNull, isNull, or, sql } =
      await import('drizzle-orm');
    const { parseAdminAccountsListQuery, UNPAID_TIERS } = await import('./accounts-query');
    // PURE resolver — no I/O, no cache, no clock of its own. It runs over the
    // row this query already selects, so the `plan` block below costs zero
    // extra queries (no N+1) and reports the same plan every server gate
    // enforces for that account.
    const { resolveBillingFromRow } = await import('../billing/services/resolve-billing');

    const {
      search,
      accountId: accountIdFilter,
      tierValues,
      paymentStatusValues,
      paidOnly,
      hasSubscription,
      minBalance,
      maxBalance,
      sortBy,
      sortDir,
      page,
      limit,
      offset,
    } = parseAdminAccountsListQuery((k: string) => c.req.query(k));
    const dir = sortDir === 'asc' ? asc : desc;

    const ownerEmail = sql<string | null>`(
      SELECT au.email FROM auth.users au
      INNER JOIN kortix.account_members am ON am.user_id = au.id
      WHERE am.account_id = ${accounts.accountId}
      ORDER BY CASE am.account_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, au.email ASC
      LIMIT 1)`;
    const memberCount = sql<number>`(
      SELECT count(*)::int FROM kortix.account_members am WHERE am.account_id = ${accounts.accountId})`;

    const conds: any[] = [];
    // Exact-id lookup — the sheet's live row, immune to the list's filters.
    if (accountIdFilter) conds.push(eq(accounts.accountId, accountIdFilter));
    if (search) {
      conds.push(
        or(
          ilike(accounts.name, `%${search}%`),
          sql`EXISTS (SELECT 1 FROM auth.users au INNER JOIN kortix.account_members am ON am.user_id = au.id
                      WHERE am.account_id = ${accounts.accountId} AND au.email ILIKE ${'%' + search + '%'})`,
        ),
      );
    }
    if (tierValues.length) conds.push(inArray(creditAccounts.tier, tierValues));
    // "Paid only" → any tier that isn't free/none (matches isPaidTier semantics).
    if (paidOnly) {
      conds.push(and(isNotNull(creditAccounts.tier), notInArray(creditAccounts.tier, [...UNPAID_TIERS])));
    }
    if (paymentStatusValues.length) conds.push(inArray(creditAccounts.paymentStatus, paymentStatusValues));
    // "Has subscription" → a Stripe or RevenueCat subscription is on file.
    if (hasSubscription === true) {
      conds.push(
        or(isNotNull(creditAccounts.stripeSubscriptionId), isNotNull(creditAccounts.revenuecatSubscriptionId)),
      );
    } else if (hasSubscription === false) {
      conds.push(
        and(isNull(creditAccounts.stripeSubscriptionId), isNull(creditAccounts.revenuecatSubscriptionId)),
      );
    }
    if (minBalance) conds.push(gte(creditAccounts.balance, minBalance));
    if (maxBalance) conds.push(lte(creditAccounts.balance, maxBalance));
    const where = conds.length ? and(...conds) : undefined;

    const sortCol =
      sortBy === 'balance' ? creditAccounts.balance : sortBy === 'name' ? accounts.name : accounts.createdAt;

    const rows = await db
      .select({
        accountId: accounts.accountId,
        name: accounts.name,
        createdAt: accounts.createdAt,
        balance: creditAccounts.balance,
        expiringCredits: creditAccounts.expiringCredits,
        nonExpiringCredits: creditAccounts.nonExpiringCredits,
        dailyCreditsBalance: creditAccounts.dailyCreditsBalance,
        tier: creditAccounts.tier,
        paymentStatus: creditAccounts.paymentStatus,
        provider: creditAccounts.provider,
        planType: creditAccounts.planType,
        stripeSubscriptionId: creditAccounts.stripeSubscriptionId,
        // Read by resolveBillingFromRow's per-seat self-heal (a live seat
        // subscription outranks a stale non-paid `tier`). Not rendered.
        stripeSubscriptionStatus: creditAccounts.stripeSubscriptionStatus,
        // Read by resolveBillingFromRow's session-limit override. Not rendered
        // either, but the resolver takes ONE row and answers the WHOLE billing
        // question from it — handing it a partial row silently mis-answers the
        // parts this projection does not happen to render today.
        maxConcurrentSessions: creditAccounts.maxConcurrentSessions,
        billingModel: creditAccounts.billingModel,
        seatCount: creditAccounts.seatCount,
        trialStatus: creditAccounts.trialStatus,
        trialTier: creditAccounts.trialTier,
        trialSeats: creditAccounts.trialSeats,
        trialStartedAt: creditAccounts.trialStartedAt,
        trialEndsAt: creditAccounts.trialEndsAt,
        trialNote: creditAccounts.trialNote,
        managedModelsOverride: creditAccounts.managedModelsOverride,
        demoEnterprise: creditAccounts.demoEnterprise,
        enterpriseEntitled: creditAccounts.enterpriseEntitled,
        // Same reason as maxConcurrentSessions above: the resolver reads the
        // JSONB overrides FIRST, so a projection without them reports the
        // legacy columns' answer for an account whose real answer expired.
        entitlementOverrides: creditAccounts.entitlementOverrides,
        ownerEmail,
        memberCount,
      })
      .from(accounts)
      .leftJoin(creditAccounts, eq(creditAccounts.accountId, accounts.accountId))
      .where(where)
      .orderBy(dir(sortCol))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(accounts)
      .leftJoin(creditAccounts, eq(creditAccounts.accountId, accounts.accountId))
      .where(where);

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
    return c.json({ accounts: [], total: 0, page: 1, limit: 50, summary: null, error: e?.message || String(e) }, 500);
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
    const { db } = await import('../shared/db');
    const { sql } = await import('drizzle-orm');

    const result: any = await db.execute(sql`
      SELECT au.id AS user_id, au.email,
             am.account_role AS account_role,
             au.created_at AS signed_up_at,
             au.last_sign_in_at AS last_sign_in_at,
             au.email_confirmed_at AS email_confirmed_at,
             au.banned_until AS banned_until,
             au.raw_app_meta_data->>'provider' AS provider,
             au.raw_app_meta_data->'providers' AS providers
      FROM kortix.account_members am
      INNER JOIN auth.users au ON au.id = am.user_id
      WHERE am.account_id = ${accountId}
      ORDER BY CASE am.account_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, au.email ASC`);
    const users = Array.isArray(result) ? result : (result?.rows ?? []);
    return c.json({ users });
  } catch (e: any) {
    return c.json({ users: [], error: e?.message || String(e) }, 500);
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
    const body = await c.req.json().catch(() => ({}));
    const roleRaw = String(body.role || '').trim();

    if (roleRaw !== 'owner' && roleRaw !== 'admin' && roleRaw !== 'member') {
      return c.json({ error: 'role must be one of owner|admin|member' }, 400);
    }
    const role = roleRaw;

    const { db } = await import('../shared/db');
    const { accountMembers } = await import('@kortix/db');
    const { and, eq } = await import('drizzle-orm');

    const [target] = await db
      .select({ accountRole: accountMembers.accountRole })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
      .limit(1);
    if (!target) return c.json({ error: 'user is not a member of this account' }, 404);
    if (target.accountRole === role) {
      return c.json({ ok: true, user_id: userId, account_role: role });
    }

    // Never demote the last owner — an ownerless account is unrecoverable
    // through the product (every owner-gated route would 403 forever).
    if (target.accountRole === 'owner' && role !== 'owner') {
      const owners = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')));
      if (owners.length <= 1) {
        return c.json({ error: 'cannot demote the last owner of an account' }, 400);
      }
    }

    await db
      .update(accountMembers)
      .set({ accountRole: role })
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

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
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
        userAgent: c.req.header('user-agent') || null,
      });
    } catch {
      /* audit is best-effort — never block the role change */
    }

    return c.json({ ok: true, user_id: userId, account_role: role });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
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
    const { db } = await import('../shared/db');
    const { projects, projectSessions } = await import('@kortix/db');
    const { eq, desc, sql } = await import('drizzle-orm');

    const sessionCount = sql<number>`(
      SELECT count(*)::int FROM ${projectSessions} ps WHERE ps.project_id = ${projects.projectId})`;
    const activeSessionCount = sql<number>`(
      SELECT count(*)::int FROM ${projectSessions} ps
      WHERE ps.project_id = ${projects.projectId}
        AND ps.status IN ('queued', 'branching', 'provisioning', 'running'))`;
    const lastSessionAt = sql<string | null>`(
      SELECT max(ps.updated_at) FROM ${projectSessions} ps WHERE ps.project_id = ${projects.projectId})`;

    const rows = await db
      .select({
        projectId: projects.projectId,
        name: projects.name,
        status: projects.status,
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        lastOpenedAt: projects.lastOpenedAt,
        sessionCount,
        activeSessionCount,
        lastSessionAt,
      })
      .from(projects)
      .where(eq(projects.accountId, accountId))
      .orderBy(desc(projects.updatedAt));

    return c.json({
      projects: rows.map((r) => ({
        ...r,
        sessionCount: Number(r.sessionCount ?? 0),
        activeSessionCount: Number(r.activeSessionCount ?? 0),
      })),
    });
  } catch (e: any) {
    return c.json({ projects: [], error: e?.message || String(e) }, 500);
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
    const { db } = await import('../shared/db');
    const { accounts, projects, projectSessions } = await import('@kortix/db');
    const { and, eq, ilike, inArray, or, sql } = await import('drizzle-orm');
    const { parseAdminProjectsListQuery } = await import('./projects-query');
    const { ACTIVE_SESSION_STATUSES } = await import('../projects/lib/session-status');

    const { search, accountId, invalidAccountId, statusValues, sortBy, sortDir, page, limit, offset } =
      parseAdminProjectsListQuery((k: string) => c.req.query(k));

    // A malformed accountId narrows to nothing rather than widening to
    // everything — an operator who mistypes an id must not be handed the fleet.
    if (invalidAccountId) {
      return c.json({ projects: [], total: 0, page, limit });
    }

    const ownerEmail = sql<string | null>`(
      SELECT au.email FROM auth.users au
      INNER JOIN kortix.account_members am ON am.user_id = au.id
      WHERE am.account_id = ${accounts.accountId}
      ORDER BY CASE am.account_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, au.email ASC
      LIMIT 1)`;
    const sessionCount = sql<number>`(
      SELECT count(*)::int FROM ${projectSessions} ps WHERE ps.project_id = ${projects.projectId})`;
    // Bound one-parameter-per-status: a bare `IN ${array}` binds the whole array
    // as a single value and matches nothing.
    const activeStatuses = sql.join(
      ACTIVE_SESSION_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    );
    const activeSessionCount = sql<number>`(
      SELECT count(*)::int FROM ${projectSessions} ps
      WHERE ps.project_id = ${projects.projectId}
        AND ps.status::text IN (${activeStatuses}))`;
    const lastSessionAt = sql<string | null>`(
      SELECT max(ps.created_at) FROM ${projectSessions} ps WHERE ps.project_id = ${projects.projectId})`;

    const conds: any[] = [];
    if (search) {
      conds.push(
        or(
          ilike(projects.name, `%${search}%`),
          ilike(accounts.name, `%${search}%`),
          sql`EXISTS (SELECT 1 FROM auth.users au INNER JOIN kortix.account_members am ON am.user_id = au.id
                      WHERE am.account_id = ${projects.accountId} AND au.email ILIKE ${'%' + search + '%'})`,
        ),
      );
    }
    if (accountId) conds.push(eq(projects.accountId, accountId));
    if (statusValues.length) conds.push(inArray(projects.status, statusValues));
    const where = conds.length ? and(...conds) : undefined;

    const dirSql = sortDir === 'asc' ? sql`asc` : sql`desc`;
    const sortExpr =
      sortBy === 'created' ? sql`${projects.createdAt}` : sortBy === 'sessions' ? sessionCount : lastSessionAt;
    // `project_id` breaks ties so pagination cannot repeat or skip a row when
    // many projects share a sort value (e.g. sessionCount 0).
    const orderBy = sql`${sortExpr} ${dirSql} nulls last, ${projects.projectId} desc`;

    const rows = await db
      .select({
        projectId: projects.projectId,
        name: projects.name,
        status: projects.status,
        accountId: projects.accountId,
        accountName: accounts.name,
        ownerEmail,
        createdAt: projects.createdAt,
        sessionCount,
        activeSessionCount,
        lastSessionAt,
      })
      .from(projects)
      .innerJoin(accounts, eq(accounts.accountId, projects.accountId))
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(projects)
      .innerJoin(accounts, eq(accounts.accountId, projects.accountId))
      .where(where);

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
    return c.json({ projects: [], total: 0, page: 1, limit: 50, error: e?.message || String(e) }, 500);
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
    const { db } = await import('../shared/db');
    const { creditLedger } = await import('@kortix/db');
    const { eq, desc } = await import('drizzle-orm');
    const entries = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.accountId, accountId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(limit);
    return c.json({ entries });
  } catch (e: any) {
    return c.json({ entries: [], error: e?.message || String(e) }, 500);
  }
  },
);

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
    const body = await c.req.json().catch(() => ({}));
    const amount = Number(body.amount);
    const description = String(body.description || 'Admin credit grant');
    const isExpiring = body.isExpiring !== false;
    if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'amount must be a positive number' }, 400);

    const { grantCredits, getBalance } = await import('../billing/services/credits');
    await grantCredits(accountId, amount, 'admin_grant', `${description} (by admin ${actorUserId ?? 'unknown'})`, isExpiring);
    const balance = await getBalance(accountId);
    return c.json({ ok: true, balance });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
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
    const body = await c.req.json().catch(() => ({}));
    const amount = Number(body.amount);
    const description = String(body.description || 'Admin credit debit');
    if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'amount must be a positive number' }, 400);

    const { grantCredits, getBalance } = await import('../billing/services/credits');
    await grantCredits(accountId, -Math.abs(amount), 'admin_debit', `${description} (by admin ${actorUserId ?? 'unknown'})`, false);
    const balance = await getBalance(accountId);
    return c.json({ ok: true, balance });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
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
    const body = await c.req.json().catch(() => ({}));
    const tier = String(body.tier || '').trim();

    const { isValidTier } = await import('../billing/services/tiers');
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

    const { getSubscriptionInfo } = await import('../billing/repositories/credit-accounts');
    const { applyAdminOverride } = await import('../billing/services/account-write-owner');
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
      const { recordAuditEvent } = await import('../shared/audit');
      await recordAuditEvent({
        accountId,
        actorUserId,
        action: 'admin.account.tier.set',
        resourceType: 'credit_account',
        resourceId: accountId,
        before: { tier: before?.tier ?? null },
        after: { tier },
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
        userAgent: c.req.header('user-agent') || null,
      });
    } catch {
      /* audit is best-effort — never block the tier change */
    }

    return c.json({ ok: true, tier });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
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
      const body = await c.req.json().catch(() => ({}));
      const enabled = body.enabled;
      if (typeof enabled !== 'boolean') {
        return c.json({ error: 'enabled must be a boolean' }, 400);
      }

      const { isEnterpriseEntitled } = await import('../billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../billing/services/account-write-owner');
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
        const { recordAuditEvent } = await import('../shared/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.enterprise_entitlement.set',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { enterprise_entitled: before },
          after: { enterprise_entitled: enabled },
          ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the entitlement change */
      }

      return c.json({ ok: true, enabled });
    } catch (e: any) {
      return c.json({ error: e?.message || String(e) }, 500);
    }
  },
);

// ── Set account concurrent-session override ─────────────────────────────────
// `null` restores the tier-derived limit. Operators use this route for account
// policy changes and for bounded end-to-end limit verification.
adminApp.openapi(
  createRoute({
    method: 'post',
    path: '/api/accounts/{id}/session-limit',
    tags: ['admin'],
    summary: "Set an account's concurrent-session override",
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              max_concurrent_sessions: z.number().int().min(1).max(MAX_ACCOUNT_SESSION_LIMIT).nullable(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          ok: z.boolean(),
          previous: z.number().int().nullable(),
          current: z.number().int().nullable(),
        }),
        'Updated concurrent-session override',
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
    const body = c.req.valid('json') as { max_concurrent_sessions: number | null };
    const { getSubscriptionInfo } = await import('../billing/repositories/credit-accounts');
    const { applyAdminOverride } = await import('../billing/services/account-write-owner');
    const { clearAccountLimitCache } = await import('../shared/account-limits');
    const { recordAuditEvent } = await import('../shared/audit');

    const result = await setAccountSessionLimit(
      {
        accountId,
        actorUserId,
        maxConcurrentSessions: body.max_concurrent_sessions,
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
        userAgent: c.req.header('user-agent') || null,
      },
      {
        getCurrent: async () => (await getSubscriptionInfo(accountId))?.maxConcurrentSessions ?? null,
        persist: async (id, value) => {
          await applyAdminOverride(
            id,
            { maxConcurrentSessions: value },
            { userId: actorUserId, action: 'admin.account.session_limit.set' },
          );
        },
        clearCache: clearAccountLimitCache,
        recordAudit: recordAuditEvent,
      },
    );

    return c.json({ ok: true, ...result });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
  },
);

// ── Grant / replace an account trial ─────────────────────────────────────────
// An admin-issued trial makes the account BEHAVE as `tier_key` (entitlements,
// project/session limits, managed-models gate) until `duration_days` elapse —
// without touching `credit_accounts.tier`, which belongs to the Stripe webhook.
// Re-granting overwrites the window (extend/adjust = re-grant). `credit_grant`
// (USD credits) funds sandbox compute: even a BYOK trial needs wallet balance
// to run sessions.
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
        '../billing/services/trial-admin'
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
        const { recordAuditEvent } = await import('../shared/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.trial.grant',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { trial: result.before },
          after: { trial: result.current, credit_granted: result.creditGranted },
          ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the grant */
      }

      return c.json({ ok: true, trial: result.current, credit_granted: result.creditGranted });
    } catch (e: any) {
      return c.json({ error: e?.message || String(e) }, 500);
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
        return c.json({ error: e?.message || String(e) }, 400);
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
          ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the revoke */
      }

      return c.json({ ok: true, trial: result.current });
    } catch (e: any) {
      return c.json({ error: e?.message || String(e) }, 500);
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

      const { getCreditAccount } = await import('../billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../billing/services/account-write-owner');
      const before = (await getCreditAccount(accountId))?.managedModelsOverride ?? null;
      // The chokepoint invalidates this account's billing cache — the one cache
      // the managed-models answer is served from on the gateway auth hot path.
      await applyAdminOverride(
        accountId,
        { managedModelsOverride: body.override },
        { userId: actorUserId, action: 'admin.account.managed_models.set' },
      );

      try {
        const { recordAuditEvent } = await import('../shared/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.managed_models.set',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { managed_models_override: before },
          after: { managed_models_override: body.override },
          ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the change */
      }

      return c.json({ ok: true, override: body.override });
    } catch (e: any) {
      return c.json({ error: e?.message || String(e) }, 500);
    }
  },
);

// ── Set the account enterprise-demo flag (admin-only) ────────────────────────
// The self-serve IAM toggle was retired: enterprise-demo is an operator
// decision now (see accounts/iam/enterprise-demo.ts). Same storage
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

      const { isDemoEnterprise } = await import('../billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../billing/services/account-write-owner');
      const before = await isDemoEnterprise(accountId);
      await applyAdminOverride(
        accountId,
        { demoEnterprise: body.enabled },
        { userId: actorUserId, action: 'admin.account.enterprise_demo.set' },
      );

      try {
        const { recordAuditEvent } = await import('../shared/audit');
        await recordAuditEvent({
          accountId,
          actorUserId,
          action: 'admin.account.enterprise_demo.set',
          resourceType: 'credit_account',
          resourceId: accountId,
          before: { demo_enterprise: before },
          after: { demo_enterprise: body.enabled },
          ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the change */
      }

      return c.json({ ok: true, enabled: body.enabled });
    } catch (e: any) {
      return c.json({ error: e?.message || String(e) }, 500);
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
      } = await import('../billing/services/entitlement-overrides');
      const validated = validateOverridePatch(raw);
      if (!validated.ok) return c.json({ error: validated.error }, 400);

      const { getCreditAccount } = await import('../billing/repositories/credit-accounts');
      const { applyAdminOverride } = await import('../billing/services/account-write-owner');
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
          ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
          userAgent: c.req.header('user-agent') || null,
        });
      } catch {
        /* audit is best-effort — never block the override change */
      }

      return c.json({ ok: true, overrides: stored });
    } catch (e: any) {
      return c.json({ error: e?.message || String(e) }, 500);
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
    const { db } = await import('../shared/db');
    const { platformSettings } = await import('@kortix/db');
    const { eq } = await import('drizzle-orm');
    const { PROVIDER_DISTRIBUTION_KEY } = await import('../platform/services/provider-balancer');
    const [row] = await db.select({ value: platformSettings.value }).from(platformSettings)
      .where(eq(platformSettings.key, PROVIDER_DISTRIBUTION_KEY)).limit(1);
    return c.json({ allowed: config.ALLOWED_SANDBOX_PROVIDERS, default: config.getDefaultProvider(), weights: row?.value ?? {} });
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
    const body = await c.req.json().catch(() => ({}));
    const src = (body && typeof body.weights === 'object') ? body.weights : body;
    const { config } = await import('../config');
    const weights: Record<string, number> = {};
    for (const p of config.ALLOWED_SANDBOX_PROVIDERS) {
      const w = Number(src?.[p]); if (Number.isFinite(w) && w >= 0) weights[p] = w;
    }
    const { db } = await import('../shared/db');
    const { platformSettings } = await import('@kortix/db');
    const { PROVIDER_DISTRIBUTION_KEY, invalidateProviderDistributionCache } = await import('../platform/services/provider-balancer');
    await db.insert(platformSettings).values({ key: PROVIDER_DISTRIBUTION_KEY, value: weights, updatedAt: new Date() })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: weights, updatedAt: new Date() } });
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
    const body = await c.req.json().catch(() => ({}));
    const value = { enabled: body?.enabled === true };
    const { db } = await import('../shared/db');
    const { platformSettings } = await import('@kortix/db');
    const { PROVIDER_FALLBACK_KEY, invalidateRuntimeSettings, refreshRuntimeSettings } = await import('../platform/services/runtime-settings');
    await db.insert(platformSettings).values({ key: PROVIDER_FALLBACK_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
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
    const { db } = await import('../shared/db');
    const { sessionSandboxes } = await import('@kortix/db');
    const { desc, eq, and, sql } = await import('drizzle-orm');
    const limit = Math.min(Number(c.req.query('limit') || 200), 1000);
    const conds: any[] = [];
    const prov = c.req.query('provider'); const st = c.req.query('status');
    if (prov) conds.push(eq(sessionSandboxes.provider, prov as any));
    if (st) conds.push(eq(sessionSandboxes.status, st as any));
    const rows = await db.select({
      sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId, projectId: sessionSandboxes.projectId,
      provider: sessionSandboxes.provider, externalId: sessionSandboxes.externalId,
      status: sessionSandboxes.status, lastUsedAt: sessionSandboxes.lastUsedAt,
    }).from(sessionSandboxes).where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(sessionSandboxes.updatedAt)).limit(limit);
    const byProvider = await db.execute(sql`SELECT provider AS provider, count(*)::int AS count FROM kortix.session_sandboxes WHERE status <> 'archived' GROUP BY provider`);
    return c.json({ sandboxes: rows, byProvider: (byProvider as any).rows ?? byProvider });
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
    const body = await c.req.json().catch(() => ({}));
    const target = String(body.targetProvider || '');
    const { config } = await import('../config');
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(target)) return c.json({ error: 'invalid targetProvider' }, 400);
    const { db } = await import('../shared/db');
    const { sessionSandboxes, projectSessions, projects } = await import('@kortix/db');
    const { eq } = await import('drizzle-orm');
    const [sb] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId)).limit(1);
    if (!sb) return c.json({ error: 'sandbox not found' }, 404);
    if (sb.provider === target) return c.json({ error: 'already on target provider' }, 400);
    const [sess] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
    if (!sess) return c.json({ error: 'session not found' }, 404);
    const [proj] = await db.select().from(projects).where(eq(projects.projectId, sess.projectId)).limit(1);
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
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId));
    const { allocateRuntimeOnOpen } = await import('../projects/routes/shared');
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
    const { db } = await import('../shared/db');
    const { providerEvents } = await import('@kortix/db');
    const { gte, desc } = await import('drizzle-orm');
    const days = Math.min(Math.max(Number(c.req.query('days') || 7), 1), 90);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const rows = await db.select().from(providerEvents)
      .where(gte(providerEvents.createdAt, cutoff))
      .orderBy(desc(providerEvents.createdAt)).limit(20_000);

    const pct = (xs: number[], p: number): number => {
      if (!xs.length) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))]);
    };
    const normLabel = (l: string): string =>
      l.startsWith('provider-create') ? 'provider-create'
        : (l === 'image-built' || l === 'image-cached') ? 'image' : l;
    const dayKey = (d: Date): string => new Date(d).toISOString().slice(0, 10);

    const provision = rows.filter((r: any) => r.kind === 'provision');
    const migrate = rows.filter((r: any) => r.kind === 'migrate');
    const provNames = Array.from(new Set(provision.map((r: any) => r.provider))).sort();

    // Per-provider summary + phase breakdown.
    const providers = provNames.map((p) => {
      const evs = provision.filter((r: any) => r.provider === p);
      const ok = evs.filter((r: any) => r.outcome === 'ok');
      const error = evs.filter((r: any) => r.outcome === 'error');
      const stopped = evs.filter((r: any) => r.outcome === 'stopped');
      const okMs = ok.map((r: any) => r.totalMs ?? 0).filter((n: number) => n > 0);
      const finished = ok.length + error.length;
      const phaseTotals: Record<string, { sum: number; n: number }> = {};
      for (const r of ok) {
        for (const m of (r.marks as any[]) ?? []) {
          const k = normLabel(String(m.label));
          const d = Number(m.deltaMs) || 0;
          (phaseTotals[k] ||= { sum: 0, n: 0 }).sum += d;
          phaseTotals[k].n += 1;
        }
      }
      const phases = Object.entries(phaseTotals).map(([label, v]) => ({ label, avgMs: Math.round(v.sum / v.n) }));
      return {
        provider: p,
        provisions: evs.length, ok: ok.length, error: error.length, stopped: stopped.length,
        successRate: finished ? Math.round((ok.length / finished) * 100) : null,
        p50Ms: pct(okMs, 50), p95Ms: pct(okMs, 95),
        avgMs: okMs.length ? Math.round(okMs.reduce((a: number, b: number) => a + b, 0) / okMs.length) : 0,
        phases,
      };
    });

    // Daily time-series: provision count + p50 latency per provider per day.
    const dayBuckets: Record<string, Record<string, number[]>> = {};
    for (const r of provision as any[]) {
      const dk = dayKey(r.createdAt);
      ((dayBuckets[dk] ||= {})[r.provider] ||= []);
      if (r.outcome === 'ok' && r.totalMs) dayBuckets[dk][r.provider].push(r.totalMs);
    }
    const allDays: string[] = [];
    for (let i = days - 1; i >= 0; i--) allDays.push(dayKey(new Date(Date.now() - i * 86_400_000)));
    const countByDay: Record<string, Record<string, number>> = {};
    for (const r of provision as any[]) {
      const dk = dayKey(r.createdAt);
      (countByDay[dk] ||= {});
      countByDay[dk][r.provider] = (countByDay[dk][r.provider] || 0) + 1;
    }
    const latencyByDay = allDays.map((d) => {
      const row: Record<string, unknown> = { date: d };
      for (const p of provNames) row[p] = dayBuckets[d]?.[p]?.length ? pct(dayBuckets[d][p], 50) : null;
      return row;
    });
    const volumeByDay = allDays.map((d) => {
      const row: Record<string, unknown> = { date: d };
      for (const p of provNames) row[p] = countByDay[d]?.[p] ?? 0;
      return row;
    });

    // Migration flows.
    const flowMap: Record<string, number> = {};
    for (const r of migrate as any[]) {
      const key = `${r.fromProvider ?? '?'}→${r.provider}`;
      flowMap[key] = (flowMap[key] || 0) + 1;
    }
    const migrations = Object.entries(flowMap).map(([flow, count]) => ({ flow, count }));

    const okTot = provision.filter((r: any) => r.outcome === 'ok').length;
    const errTot = provision.filter((r: any) => r.outcome === 'error').length;
    const recentErrors = (rows as any[])
      .filter((r) => r.outcome === 'error')
      .slice(0, 10)
      .map((r) => ({ provider: r.provider, errorClass: r.errorClass, error: r.error, createdAt: r.createdAt }));

    return c.json({
      days,
      totals: {
        provisions: provision.length, ok: okTot, error: errTot,
        stopped: provision.filter((r: any) => r.outcome === 'stopped').length,
        migrations: migrate.length,
        successRate: okTot + errTot ? Math.round((okTot / (okTot + errTot)) * 100) : null,
      },
      providers, latencyByDay, volumeByDay, migrations, recentErrors,
    });
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
      if (!UUID_RE.test(accountId)) {
        return c.json({ error: 'account_id must be a uuid' }, 400);
      }

      const { db } = await import('../shared/db');
      const { accounts } = await import('@kortix/db');
      const { eq } = await import('drizzle-orm');
      // Refuse a grant on an account that does not exist. A row pointing at a
      // typo'd uuid would sit in the table looking like a real support session.
      const [account] = await db
        .select({ accountId: accounts.accountId, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.accountId, accountId))
        .limit(1);
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
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
        userAgent: c.req.header('user-agent') || null,
      });

      return c.json({
        grant_id: grant.id,
        account_id: accountId,
        account_name: account.name ?? null,
        expires_at: expiresAt.toISOString(),
      });
    } catch (e: any) {
      return c.json({ error: e?.message || String(e) }, 500);
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
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
        userAgent: c.req.header('user-agent') || null,
      });

      return c.json({
        ok: true,
        grant_id: grant.id,
        revoked_at: grant.revokedAt ? grant.revokedAt.toISOString() : null,
      });
    } catch (e: any) {
      return c.json({ error: e?.message || String(e) }, 500);
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
      const { db } = await import('../shared/db');
      const { accounts } = await import('@kortix/db');
      const { inArray } = await import('drizzle-orm');
      const names = new Map<string, string | null>();
      if (grants.length > 0) {
        const rows = await db
          .select({ accountId: accounts.accountId, name: accounts.name })
          .from(accounts)
          .where(inArray(accounts.accountId, grants.map((g) => g.targetAccountId)));
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
      return c.json({ error: e?.message || String(e) }, 500);
    }
  },
);
