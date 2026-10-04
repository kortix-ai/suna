/**
 * The database reads and writes behind the admin console routes (admin/index.ts).
 *
 * Each function is the exact query its route ran inline. The modules load
 * lazily, as they did inside the handlers, so importing the admin router still
 * loads none of them.
 */
import { qualifiedColumn } from '../shared/sql-qualified-column';
import type { AdminAccountsListQuery } from './accounts-query';
import type { AdminProjectsListQuery } from './projects-query';

/** One page of `GET /api/accounts` plus the filtered total. Throws the driver error as-is. */
export async function listAdminAccountsPage(query: AdminAccountsListQuery) {
  const { db } = await import('../shared/db');
  const { accounts, creditAccounts } = await import('@kortix/db');
  const { and, asc, desc, eq, gte, lte, inArray, notInArray, isNotNull, isNull, or, sql } =
    await import('drizzle-orm');
  const { UNPAID_TIERS } = await import('./accounts-query');

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
    limit,
    offset,
  } = query;
  const dir = sortDir === 'asc' ? asc : desc;

  // The PRIMARY owner's email, matching how the product derives an account's
  // identity (resolveAccountDisplayNames): the personal-account owner first
  // (`user_id = account_id` — a personal account's id IS its creator's user
  // id), then the earliest-joined owner. The old tiebreak was `au.email ASC`,
  // which let a support operator added as a second owner displace the real
  // customer whenever their address sorted first alphabetically.
  const ownerEmail = sql<string | null>`(
      SELECT au.email FROM auth.users au
      INNER JOIN kortix.account_members am ON am.user_id = au.id
      WHERE am.account_id = ${qualifiedColumn(accounts.accountId)}
      ORDER BY (am.user_id = ${qualifiedColumn(accounts.accountId)}) DESC,
               CASE am.account_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               am.joined_at ASC, au.email ASC
      LIMIT 1)`;
  const memberCount = sql<number>`(
      SELECT count(*)::int FROM kortix.account_members am WHERE am.account_id = ${qualifiedColumn(accounts.accountId)})`;

  const conds: any[] = [];
  // Exact-id lookup — the sheet's live row, immune to the list's filters.
  if (accountIdFilter) conds.push(eq(accounts.accountId, accountIdFilter));
  if (search) {
    // The search predicate is shared by the list and count queries; see
    // accounts-search.ts for why the email branch must stay users-first.
    const { adminAccountsSearchCondition } = await import('./accounts-search');
    conds.push(adminAccountsSearchCondition(search));
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
      // The resolver takes ONE row and reads the JSONB overrides FIRST,
      // so a projection without them reports the legacy columns' answer
      // for an account whose real answer expired.
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

  return { rows, total };
}

/** Members of one account with their auth identity, owners first. */
export async function listAdminAccountMembers(accountId: string): Promise<unknown[]> {
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
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

/** Every project one account owns, with session counts, newest update first. */
export async function listAdminAccountProjects(accountId: string) {
  const { db } = await import('../shared/db');
  const { projects, projectSessions } = await import('@kortix/db');
  const { eq, desc, sql } = await import('drizzle-orm');

  const sessionCount = sql<number>`(
      SELECT count(*)::int FROM ${projectSessions} ps WHERE ps.project_id = ${qualifiedColumn(projects.projectId)})`;
  const activeSessionCount = sql<number>`(
      SELECT count(*)::int FROM ${projectSessions} ps
      WHERE ps.project_id = ${qualifiedColumn(projects.projectId)}
        AND ps.status IN ('queued', 'branching', 'provisioning', 'running'))`;
  const lastSessionAt = sql<string | null>`(
      SELECT max(ps.updated_at) FROM ${projectSessions} ps WHERE ps.project_id = ${qualifiedColumn(projects.projectId)})`;

  return db
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
}

/** One page of `GET /api/projects` across every account, plus the filtered total. */
export async function listAdminProjectsPage(query: AdminProjectsListQuery) {
  const { db } = await import('../shared/db');
  const { accounts, projects, projectSessions } = await import('@kortix/db');
  const { and, eq, ilike, inArray, or, sql } = await import('drizzle-orm');
  const { ACTIVE_SESSION_STATUSES } = await import('../projects/lib/session-status');

  const { search, accountId, statusValues, sortBy, sortDir, limit, offset } = query;

  // The PRIMARY owner's email, matching how the product derives an account's
  // identity (resolveAccountDisplayNames): the personal-account owner first
  // (`user_id = account_id` — a personal account's id IS its creator's user
  // id), then the earliest-joined owner. The old tiebreak was `au.email ASC`,
  // which let a support operator added as a second owner displace the real
  // customer whenever their address sorted first alphabetically.
  const ownerEmail = sql<string | null>`(
      SELECT au.email FROM auth.users au
      INNER JOIN kortix.account_members am ON am.user_id = au.id
      WHERE am.account_id = ${qualifiedColumn(accounts.accountId)}
      ORDER BY (am.user_id = ${qualifiedColumn(accounts.accountId)}) DESC,
               CASE am.account_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               am.joined_at ASC, au.email ASC
      LIMIT 1)`;
  const sessionCount = sql<number>`(
      SELECT count(*)::int FROM ${projectSessions} ps WHERE ps.project_id = ${qualifiedColumn(projects.projectId)})`;
  // Bound one-parameter-per-status: a bare `IN ${array}` binds the whole array
  // as a single value and matches nothing.
  const activeStatuses = sql.join(
    ACTIVE_SESSION_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const activeSessionCount = sql<number>`(
      SELECT count(*)::int FROM ${projectSessions} ps
      WHERE ps.project_id = ${qualifiedColumn(projects.projectId)}
        AND ps.status::text IN (${activeStatuses}))`;
  const lastSessionAt = sql<string | null>`(
      SELECT max(ps.created_at) FROM ${projectSessions} ps WHERE ps.project_id = ${qualifiedColumn(projects.projectId)})`;

  const conds: any[] = [];
  if (search) {
    conds.push(
      or(
        ilike(projects.name, `%${search}%`),
        ilike(accounts.name, `%${search}%`),
        sql`EXISTS (SELECT 1 FROM auth.users au INNER JOIN kortix.account_members am ON am.user_id = au.id
                      WHERE am.account_id = ${qualifiedColumn(projects.accountId)} AND au.email ILIKE ${'%' + search + '%'})`,
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

  return { rows, total };
}

/** The newest `limit` credit-ledger entries of one account. */
export async function listAdminCreditLedger(accountId: string, limit: number) {
  const { db } = await import('../shared/db');
  const { creditLedger } = await import('@kortix/db');
  const { eq, desc } = await import('drizzle-orm');
  return db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.accountId, accountId))
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit);
}

/** The stored provider split weights, or undefined when none were ever set. */
export async function readProviderDistribution(): Promise<unknown> {
  const { db } = await import('../shared/db');
  const { platformSettings } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');
  const { PROVIDER_DISTRIBUTION_KEY } = await import('../platform/services/provider-balancer');
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings)
    .where(eq(platformSettings.key, PROVIDER_DISTRIBUTION_KEY)).limit(1);
  return row?.value;
}

/** Upsert the provider split weights. */
export async function saveProviderDistribution(weights: Record<string, number>): Promise<void> {
  const { db } = await import('../shared/db');
  const { platformSettings } = await import('@kortix/db');
  const { PROVIDER_DISTRIBUTION_KEY } = await import('../platform/services/provider-balancer');
  await db.insert(platformSettings).values({ key: PROVIDER_DISTRIBUTION_KEY, value: weights, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: weights, updatedAt: new Date() } });
}

/** Upsert the provider failover toggle. */
export async function saveProviderFallback(value: { enabled: boolean }): Promise<void> {
  const { db } = await import('../shared/db');
  const { platformSettings } = await import('@kortix/db');
  const { PROVIDER_FALLBACK_KEY } = await import('../platform/services/runtime-settings');
  await db.insert(platformSettings).values({ key: PROVIDER_FALLBACK_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
}

/** Sandboxes, newest update first, and the non-archived count per provider. */
export async function listAdminSandboxes(filter: {
  limit: number;
  provider: string | undefined;
  status: string | undefined;
}) {
  const { db } = await import('../shared/db');
  const { sessionSandboxes } = await import('@kortix/db');
  const { desc, eq, and, sql } = await import('drizzle-orm');
  const { limit } = filter;
  const conds: any[] = [];
  const prov = filter.provider; const st = filter.status;
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
  return { rows, byProvider: (byProvider as any).rows ?? byProvider };
}

/** The sandbox row of one session. */
export async function findSessionSandbox(sessionId: string) {
  const { db } = await import('../shared/db');
  const { sessionSandboxes } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');
  const [sb] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId)).limit(1);
  return sb;
}

/** The session row of one session. */
export async function findProjectSession(sessionId: string) {
  const { db } = await import('../shared/db');
  const { projectSessions } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');
  const [sess] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  return sess;
}

/** One project row. */
export async function findProject(projectId: string) {
  const { db } = await import('../shared/db');
  const { projects } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');
  const [proj] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return proj;
}

/** Delete one session's sandbox row. */
export async function deleteSessionSandbox(sessionId: string): Promise<void> {
  const { db } = await import('../shared/db');
  const { sessionSandboxes } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sessionId, sessionId));
}

/** Provider events since `cutoff`, newest first, at most 20,000. */
export async function listProviderEventsSince(cutoff: Date) {
  const { db } = await import('../shared/db');
  const { providerEvents } = await import('@kortix/db');
  const { gte, desc } = await import('drizzle-orm');
  return db.select().from(providerEvents)
    .where(gte(providerEvents.createdAt, cutoff))
    .orderBy(desc(providerEvents.createdAt)).limit(20_000);
}

/** One account's id and name, or undefined when it does not exist. */
export async function findAccountName(accountId: string) {
  const { db } = await import('../shared/db');
  const { accounts } = await import('@kortix/db');
  const { eq } = await import('drizzle-orm');
  const [account] = await db
    .select({ accountId: accounts.accountId, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  return account;
}

/** The id and name of each account in `accountIds`. */
export async function listAccountNames(accountIds: string[]) {
  const { db } = await import('../shared/db');
  const { accounts } = await import('@kortix/db');
  const { inArray } = await import('drizzle-orm');
  return db
    .select({ accountId: accounts.accountId, name: accounts.name })
    .from(accounts)
    .where(inArray(accounts.accountId, accountIds));
}
