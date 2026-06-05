/**
 * Admin console API (revived for the current backend).
 *
 * Mounted at /v1/admin, gated by supabaseAuth + requireAdmin (platform role
 * 'admin' | 'super_admin' in kortix.platform_user_roles). Backs the web admin
 * pages under apps/web/src/app/admin/.
 *
 * Scope (v1): the safe accounts console — list accounts, account members,
 * credit ledger, and grant/debit credits (reusing the billing grantCredits
 * service). Billing-detail fields (payment status, Stripe, etc.) are returned
 * as null for now; the legacy env/exec/schema endpoints are intentionally NOT
 * restored.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { supabaseAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/require-admin';
import { makeOpenApiApp, json, errors, auth } from '../openapi';

export const adminApp = makeOpenApiApp<AppEnv>();

// Every admin route requires a logged-in platform admin.
adminApp.use('*', supabaseAuth, requireAdmin);

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
        tier: z.string().optional(),
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
    const { and, asc, desc, eq, ilike, gte, lte, inArray, or, sql } = await import('drizzle-orm');
    const { membersTableSql } = await import('./members-table');
    const mt = await membersTableSql();

    const search = (c.req.query('search') || '').trim();
    const tierValues = (c.req.query('tier') || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const minBalance = c.req.query('minBalance');
    const maxBalance = c.req.query('maxBalance');
    const sortBy = c.req.query('sortBy') || 'created';
    const dir = c.req.query('sortDir') === 'asc' ? asc : desc;
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
    const offset = (page - 1) * limit;

    const ownerEmail = sql<string | null>`(
      SELECT au.email FROM auth.users au
      INNER JOIN ${mt} am ON am.user_id = au.id
      WHERE am.account_id = ${accounts.accountId}
      ORDER BY CASE am.account_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, au.email ASC
      LIMIT 1)`;
    const memberCount = sql<number>`(
      SELECT count(*)::int FROM ${mt} am WHERE am.account_id = ${accounts.accountId})`;

    const conds: any[] = [];
    if (search) {
      conds.push(
        or(
          ilike(accounts.name, `%${search}%`),
          sql`EXISTS (SELECT 1 FROM auth.users au INNER JOIN ${mt} am ON am.user_id = au.id
                      WHERE am.account_id = ${accounts.accountId} AND au.email ILIKE ${'%' + search + '%'})`,
        ),
      );
    }
    if (tierValues.length) conds.push(inArray(creditAccounts.tier, tierValues));
    if (minBalance && minBalance.length) conds.push(gte(creditAccounts.balance, minBalance));
    if (maxBalance && maxBalance.length) conds.push(lte(creditAccounts.balance, maxBalance));
    const where = conds.length ? and(...conds) : undefined;

    const sortCol =
      sortBy === 'balance' ? creditAccounts.balance : sortBy === 'name' ? accounts.name : accounts.createdAt;

    const rows = await db
      .select({
        accountId: accounts.accountId,
        name: accounts.name,
        createdAt: accounts.createdAt,
        balance: creditAccounts.balance,
        tier: creditAccounts.tier,
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

    const list = rows.map((r) => ({
      accountId: r.accountId,
      name: r.name,
      ownerEmail: r.ownerEmail ?? null,
      memberCount: Number(r.memberCount ?? 0),
      balance: r.balance ?? null,
      // Billing-detail fields — not wired yet (follow-up): return null so the UI renders.
      expiringCredits: null,
      nonExpiringCredits: null,
      dailyCreditsBalance: null,
      tier: r.tier ?? null,
      paymentStatus: null,
      provider: null,
      planType: null,
      stripeSubscriptionId: null,
      billingCustomerId: null,
      billingCustomerEmail: null,
      createdAt: r.createdAt ? new Date(r.createdAt as any).toISOString() : null,
    }));

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
    const { membersTableSql } = await import('./members-table');
    const mt = await membersTableSql();

    const result: any = await db.execute(sql`
      SELECT au.id AS user_id, au.email,
             am.account_role AS account_role,
             au.created_at AS signed_up_at,
             au.last_sign_in_at AS last_sign_in_at,
             au.email_confirmed_at AS email_confirmed_at,
             au.banned_until AS banned_until,
             au.raw_app_meta_data->>'provider' AS provider,
             au.raw_app_meta_data->'providers' AS providers
      FROM ${mt} am
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
