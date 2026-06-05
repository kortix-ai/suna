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
    const oldProvider = sb.provider; const oldExternalId = sb.externalId;
    const { getProvider } = await import('../platform/providers');
    // Data migration is via the session git branch (KORTIX_BRANCH_NAME=sessionId):
    // the target re-clones it, so only *committed* work crosses over. Flush the
    // old box's working tree to the branch first (best-effort, only while it's
    // still active) so uncommitted changes survive the move. Same daemon contract
    // as the /commit-push route — resolveEndpoint injects the service Bearer.
    if (oldExternalId && sb.status === 'active') {
      try {
        const ep = await getProvider(oldProvider as any).resolveEndpoint(oldExternalId);
        const res = await fetch(`${ep.url.replace(/\/$/, '')}/kortix/git/commit-push`, {
          method: 'POST', headers: ep.headers,
          body: JSON.stringify({ message: `chore: flush before migrate ${oldProvider}→${target}` }),
          signal: AbortSignal.timeout(30_000),
        });
        console.log(`[migrate] flush ${sessionId} ${oldProvider}: ${res.status}`);
      } catch (e: any) {
        console.warn('[migrate] pre-teardown commit-push failed (committed work still migrates):', e?.message ?? e);
      }
    }
    if (oldExternalId) {
      getProvider(oldProvider as any).remove(oldExternalId).catch((e: any) => console.warn('[migrate] old remove failed:', e?.message ?? e));
    }
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId));
    const { kickProvisionOnOpen } = await import('../projects/routes/shared');
    await kickProvisionOnOpen(
      { row: proj as any, userId: sess.createdBy },
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
