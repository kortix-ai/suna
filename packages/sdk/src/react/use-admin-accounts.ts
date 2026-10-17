import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '../core/http/api-client';
import { useRetiredMutation, useRetiredQuery } from './retired-endpoint';

/**
 * Lifecycle of an admin-issued trial. `active` is the only status that grants
 * the trial tier; every other value is history the row keeps for audit.
 * @deprecated Trials are removed; the admin list no longer sends them.
 */
export type AdminTrialStatus = 'none' | 'active' | 'expired' | 'revoked' | 'converted';

/** The trial overlay as the admin accounts list reports it. */
export interface AdminAccountTrial {
  status: AdminTrialStatus | string;
  /** Paid tier the trial emulates (never 'free'/'none'). */
  tier: string | null;
  /** @deprecated No longer sent: a trial grants one credit amount at the start,
   *  not a monthly one. Removed in the next major. */
  monthlyUsd?: number | null;
  startedAt: string | null;
  endsAt: string | null;
  note: string | null;
}

/**
 * The plan an account BEHAVES as, as the list route resolves it.
 *
 * Distinct from `AdminAccount.tier`, which stays the STORED
 * `credit_accounts.tier` the tier filter matches on. An active admin trial and
 * an active admin trial overlays that column, so the two disagree exactly when
 * it matters most — and the console must show the resolved one.
 */
export interface AdminAccountPlan {
  /** Plan key — 'none' | 'free' | 'credits' | 'enterprise'. */
  key: string;
  /** Public ladder position: there are exactly three families. */
  family: 'free' | 'credits' | 'enterprise';
  /** Customer-facing family name — 'Free' | 'Credits' | 'Enterprise'. */
  label: string;
  /** Qualifier to render muted after the label. Null when the plan needs none. */
  sublabel: string | null;
  status: 'current' | 'non_plan';
  /** The paid plan's monthly amount in USD. Null for free, enterprise and trial. */
  monthlyUsd: number | null;
}

/**
 * One entitlement override as the account row stores it: a value plus an
 * optional ISO-8601 expiry. Absent `expires_at` = never expires.
 *
 * `value` is `unknown` on purpose. The source is a JSONB column written by
 * admin routes, data migrations, and operator SQL, so a reader narrows
 * (`typeof v === 'boolean'`) before it renders — it never assumes the shape.
 */
export interface AdminEntitlementOverrideEntry {
  value: unknown;
  /** ISO-8601. At or past this instant the server ignores the entry. */
  expires_at?: string;
}

/** The stored override map, keyed by {@link AdminOverrideKey}. */
export type AdminEntitlementOverrides = Record<string, AdminEntitlementOverrideEntry>;

/**
 * Every override key the server accepts, plus one retired key. Anything else is
 * a 400 from `validateOverridePatch`, so the console builds its rows from this
 * list rather than from free-form strings.
 *
 * Mirrors `OVERRIDE_KEYS` in
 * `apps/api/src/billing/services/entitlement-overrides.ts`, except
 * `maxConcurrentSessions`: sessions are uncapped and the server now rejects that
 * key with a 400. It stays in the union because removing a member is a breaking
 * change; drop it on the next major.
 */
export const ADMIN_OVERRIDE_KEYS = [
  'enterpriseEntitled',
  'demoEnterprise',
  'managedModelsOverride',
  'maxConcurrentSessions',
  'computeRateMultiplier',
  'sso',
  'scim',
  'rbac',
  'auditAccess',
  'branding',
  'managedModels',
  'byokFee',
] as const;

export type AdminOverrideKey = (typeof ADMIN_OVERRIDE_KEYS)[number];

/**
 * The per-feature override keys the server accepts (2026-10-15). Build console
 * rows from this list. {@link ADMIN_OVERRIDE_KEYS} keeps the retired keys
 * (`enterpriseEntitled`, `demoEnterprise`, `managedModelsOverride`,
 * `maxConcurrentSessions`, `computeRateMultiplier`) only because removing a
 * union member is a breaking change; the server answers 400 for them.
 */
export const ADMIN_ENTITLEMENT_OVERRIDE_KEYS = [
  'sso',
  'scim',
  'rbac',
  'auditAccess',
  'branding',
  'managedModels',
  // The BYOK platform fee (5% past the free monthly allowance). On by default
  // for Free and Credits; set off to waive it for one account.
  'byokFee',
] as const satisfies readonly AdminOverrideKey[];

/**
 * A merge patch (RFC 7386, scoped to the known keys): an entry SETS the key,
 * `null` DELETES it, and a key that is absent is left exactly as it was. That
 * is what makes the route safe to call from a form that only knows one field.
 */
export type AdminEntitlementOverridePatch = Partial<
  Record<AdminOverrideKey, { value: boolean | number; expires_at?: string } | null>
>;

/** Wire path of the platform-admin entitlement-override merge-patch route. */
export function adminAccountOverridesPath(accountId: string): string {
  return `/admin/api/accounts/${encodeURIComponent(accountId)}/overrides`;
}

export interface AdminAccount {
  accountId: string;
  name: string | null;
  /** The Enterprise feature layer: off, demo (self-serve) or licensed (a license contract). Absent on an older server. */
  enterprise?: 'off' | 'demo' | 'licensed';
  /**
   * The name the PRODUCT shows for this account. `name` is the raw stored
   * column, which for old rows is a migration placeholder ('Personal' /
   * 'User') that customer-facing surfaces map to "<owner email>'s Account".
   * Render this; keep `name` for exact-match debugging. Optional: an API
   * older than the field omits it — fall back to `name`.
   */
  displayName?: string | null;
  ownerEmail: string | null;
  memberCount: number;
  balance: string | null;
  expiringCredits: string | null;
  nonExpiringCredits: string | null;
  dailyCreditsBalance: string | null;
  /** STORED `credit_accounts.tier` — what the tier filter matches on. For what
   *  the account behaves as, read {@link AdminAccount.plan}. */
  tier: string | null;
  /** Resolved plan. Optional: an API older than the plan resolver omits it, so
   *  a console pointed at one falls back to the raw tier key. */
  plan?: AdminAccountPlan;
  paymentStatus: string | null;
  provider: string | null;
  planType: string | null;
  stripeSubscriptionId: string | null;
  billingCustomerId: string | null;
  billingCustomerEmail: string | null;
  createdAt: string | null;
  /** @deprecated No longer sent: trials are removed. Read {@link AdminAccount.enterprise}. */
  trial?: AdminAccountTrial;
  /** The active Enterprise contract. Null on every other account; an Enterprise
   *  account with null has no contract on file. Optional: absent on an older API. */
  contract?: AdminAccountContract | null;
  /** Set while SSO/SCIM stay on after an Enterprise license ended. Optional:
   *  absent on an older API. */
  graceEndsAt?: string | null;
  /** @deprecated No longer sent: the managed-models override is the
   *  `managedModels` key of {@link AdminAccount.entitlementOverrides}. */
  managedModelsOverride?: boolean | null;
  /** @deprecated No longer sent: read `enterprise === 'demo'`. */
  demoEnterprise?: boolean;
  /** @deprecated No longer sent: read `enterprise === 'licensed'`. */
  enterpriseEntitled?: boolean;
  /**
   * The STORED override map, exactly as the account row carries it — expiry is
   * NOT applied, so a lapsed entry is still present and the console can show an
   * operator what is on the row. Optional: an API older than the JSONB column
   * omits it. Null is tolerated because the column itself is nullable.
   */
  entitlementOverrides?: AdminEntitlementOverrides | null;
  /** @deprecated No longer sent: every account pays list compute rates. */
  computeRateMultiplier?: number;
}

/** How an Enterprise contract is paid: Stripe Checkout by card, a Stripe invoice, or outside Stripe. */
export type AdminContractCollection = 'checkout' | 'invoice' | 'manual';

/** The active Enterprise contract as the accounts list reports it. */
export interface AdminAccountContract {
  id: string;
  licenseUsd: number;
  creditsUsd: number;
  collection: AdminContractCollection | string;
  endsAt: string | null;
  autoRenews: boolean;
}

/** One Enterprise contract, any status, as the contract routes return it. */
export interface AdminEnterpriseContract {
  id: string;
  status: 'offered' | 'active' | 'ended' | 'withdrawn' | string;
  /** Annual platform fee, USD. */
  licenseUsd: number;
  /** @deprecated A license carries no credits: always 0. */
  creditsUsd: number;
  termMonths: number;
  collection: AdminContractCollection | string;
  startsAt: string | null;
  endsAt: string | null;
  autoRenews: boolean;
  stripeSubscriptionId: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface AdminCreateEnterpriseContractVariables {
  accountId: string;
  licenseUsd: number;
  /** @deprecated A license carries no credits (2026-10-15): ignored by the API, not sent. */
  creditsUsd?: number;
  /** 1–12 for a Stripe-collected contract, up to 60 for `manual`. Defaults to 12. */
  termMonths?: number;
  collection: AdminContractCollection;
  note?: string;
}

export interface AdminAccountsSummary {
  totalCredits: string;
  paidCount: number;
  negativeCount: number;
  pastDueCount: number;
}

export interface AdminAccountsResponse {
  accounts: AdminAccount[];
  total: number;
  page: number;
  limit: number;
  summary: AdminAccountsSummary | null;
  error?: string;
}

export interface AdminAccountUser {
  user_id: string;
  email: string;
  account_role: string;
  signed_up_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  banned_until: string | null;
  provider: string | null;
  providers: string[] | null;
}

/** @deprecated No replacement: only retired admin hooks use it. Removed in the next major. */
export interface AdminAccountSandbox {
  sandboxId: string;
  name: string | null;
  provider: string | null;
  externalId: string | null;
  status: string | null;
  baseUrl: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export type AdminAccountsSortBy = 'balance' | 'members' | 'name' | 'created';
export type AdminAccountsSortDir = 'asc' | 'desc';

export interface AdminAccountsFilters {
  search?: string;
  tier?: string[]; // values of creditAccounts.tier
  paymentStatus?: string[]; // values of creditAccounts.paymentStatus
  paidOnly?: boolean;
  hasSubscription?: boolean | null; // true | false | null (no filter)
  minBalance?: number | null;
  maxBalance?: number | null;
  sortBy?: AdminAccountsSortBy;
  sortDir?: AdminAccountsSortDir;
  page?: number;
  limit?: number;
}

// The admin console has a manual refresh (re-filter/re-sort); it must not
// auto-retry. `GET /admin/api/accounts` joins `accounts` to `credit_accounts`
// and can hit a `statement_timeout` (measured: prod 2026-09-27,
// 25013/25019/25056 ms), so React Query's default 3 retries would triple the
// load on an already-slow database. A failure shows the page's own error
// state. Mirrors `ANALYTICS_RETRY` in `use-admin-activity-analytics.ts`.
const ADMIN_ACCOUNTS_RETRY = false;

export function useAdminAccounts(filters: AdminAccountsFilters = {}) {
  const {
    search = '',
    tier = [],
    paymentStatus = [],
    paidOnly = false,
    hasSubscription = null,
    minBalance = null,
    maxBalance = null,
    sortBy = 'created',
    sortDir = 'desc',
    page = 1,
    limit = 50,
  } = filters;

  return useQuery<AdminAccountsResponse>({
    queryKey: [
      'admin',
      'accounts',
      search,
      tier.join(','),
      paymentStatus.join(','),
      paidOnly,
      hasSubscription,
      minBalance,
      maxBalance,
      sortBy,
      sortDir,
      page,
      limit,
    ],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (search) q.set('search', search);
      if (tier.length) q.set('tier', tier.join(','));
      if (paymentStatus.length) q.set('paymentStatus', paymentStatus.join(','));
      if (paidOnly) q.set('paid', 'true');
      if (hasSubscription === true) q.set('hasSubscription', 'true');
      if (hasSubscription === false) q.set('hasSubscription', 'false');
      if (minBalance !== null && Number.isFinite(minBalance)) q.set('minBalance', String(minBalance));
      if (maxBalance !== null && Number.isFinite(maxBalance)) q.set('maxBalance', String(maxBalance));
      q.set('sortBy', sortBy);
      q.set('sortDir', sortDir);
      q.set('page', String(page));
      q.set('limit', String(limit));
      const response = await backendApi.get<AdminAccountsResponse>(
        `/admin/api/accounts?${q.toString()}`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: 15_000,
    retry: ADMIN_ACCOUNTS_RETRY,
    placeholderData: (prev) => prev,
  });
}

/** Wire path of the exact-id single-account lookup (list route + accountId filter). */
export function adminAccountLookupPath(accountId: string): string {
  return `/admin/api/accounts?accountId=${encodeURIComponent(accountId)}&limit=1`;
}

/**
 * Live single-account row for the admin detail sheet. Uses the list route's
 * exact-id filter, so it stays correct when the list's own filters (tier,
 * balance, payment status) no longer match the account after a mutation —
 * the bug where the sheet kept rendering a pre-mutation snapshot.
 * Invalidated by the same ['admin','accounts', accountId] subtree every admin
 * mutation already targets.
 */
export function useAdminAccount(accountId: string | null) {
  return useQuery<AdminAccount | null>({
    queryKey: ['admin', 'accounts', accountId, 'detail'],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<AdminAccountsResponse>(
        adminAccountLookupPath(accountId!),
      );
      if (response.error) throw new Error(response.error.message);
      return response.data?.accounts?.[0] ?? null;
    },
    staleTime: 5_000,
    retry: ADMIN_ACCOUNTS_RETRY,
  });
}

export function useAdminAccountUsers(accountId: string | null) {
  return useQuery<{ users: AdminAccountUser[] }>({
    queryKey: ['admin', 'accounts', accountId, 'users'],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<{ users: AdminAccountUser[] }>(`/admin/api/accounts/${accountId}/users`);
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
}

export function useAdminGrantCredits() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { accountId: string; amount: number; description: string; isExpiring: boolean }>({
    mutationFn: async ({ accountId, amount, description, isExpiring }) => {
      const response = await backendApi.post(`/admin/api/accounts/${accountId}/credits`, { amount, description, isExpiring });
      if (response.error) throw new Error(response.error.message);
      return response.data;
    },
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'accounts', accountId] });
    },
  });
}

export function useAdminDebitCredits() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { accountId: string; amount: number; description: string }>({
    mutationFn: async ({ accountId, amount, description }) => {
      const response = await backendApi.post(`/admin/api/accounts/${accountId}/credits/debit`, { amount, description });
      if (response.error) throw new Error(response.error.message);
      return response.data;
    },
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'accounts', accountId] });
    },
  });
}

// Set an account's plan tier (e.g. activate Enterprise → unlocks SSO + SCIM).
export function useAdminSetTier() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { accountId: string; tier: string }>({
    mutationFn: async ({ accountId, tier }) => {
      const response = await backendApi.post(`/admin/api/accounts/${accountId}/tier`, { tier });
      if (response.error) throw new Error(response.error.message);
      return response.data;
    },
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'accounts', accountId] });
    },
  });
}

/**
 * Every entitlement mutation below invalidates the same two keys the credit
 * mutations do: the paginated accounts list (the row carries
 * `entitlementOverrides`; `trial` is served by the per-account
 * `accounts/{id}/trial` routes) and the per-account detail subtree.
 */
function invalidateAdminAccount(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string,
): void {
  queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] });
  queryClient.invalidateQueries({ queryKey: ['admin', 'accounts', accountId] });
}

export interface AdminGrantTrialVariables {
  accountId: string;
  /** An existing paid tier key — the server rejects 'free' and 'none'. */
  tierKey: string;
  durationDays: number;
  /** USD wallet credits granted now AND every 30 days during the trial. */
  creditGrant?: number;
  note?: string;
}

export interface AdminTrialMutationResult {
  ok: boolean;
  trial: AdminAccountTrial;
  credit_granted?: number;
}

/**
 * Grant or replace an admin-issued trial. The account BEHAVES as `tierKey`
 * until the window ends, without touching `credit_accounts.tier` (which the
 * Stripe webhook owns). Re-granting over an active trial is allowed and
 * overwrites the window — extend/adjust = re-grant.
 */
export function useAdminGrantTrial() {
  const queryClient = useQueryClient();
  return useMutation<AdminTrialMutationResult, Error, AdminGrantTrialVariables>({
    mutationFn: async ({ accountId, tierKey, durationDays, creditGrant, note }) => {
      const body: Record<string, unknown> = {
        tier_key: tierKey,
        duration_days: durationDays,
      };
      if (creditGrant !== undefined) body.credit_grant = creditGrant;
      if (note !== undefined) body.note = note;
      const response = await backendApi.post<AdminTrialMutationResult>(
        `/admin/api/accounts/${accountId}/trial`,
        body,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: (_data, { accountId }) => invalidateAdminAccount(queryClient, accountId),
  });
}

/** Revoke an active trial immediately. The route answers 400 when none is active. */
export function useAdminRevokeTrial() {
  const queryClient = useQueryClient();
  return useMutation<AdminTrialMutationResult, Error, { accountId: string }>({
    mutationFn: async ({ accountId }) => {
      const response = await backendApi.delete<AdminTrialMutationResult>(
        `/admin/api/accounts/${accountId}/trial`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: (_data, { accountId }) => invalidateAdminAccount(queryClient, accountId),
  });
}

/**
 * @deprecated The route is retired (410). Fails at once with `ENDPOINT_RETIRED`
 * and sends no request. Set the `managedModels` key with
 * {@link useAdminSetOverrides}. Removed in the next major.
 */
export function useAdminSetManagedModels() {
  return useRetiredMutation<
    { ok: boolean; override: boolean | null },
    { accountId: string; override: boolean | null }
  >('useAdminSetManagedModels');
}

/**
 * @deprecated The Enterprise preview is retired (410). Fails at once with
 * `ENDPOINT_RETIRED` and sends no request. Grant an Enterprise trial with
 * {@link useAdminGrantTrial}. Removed in the next major.
 */
export function useAdminSetEnterpriseDemo() {
  return useRetiredMutation<{ ok: boolean; enabled: boolean }, { accountId: string; enabled: boolean }>(
    'useAdminSetEnterpriseDemo',
  );
}

/**
 * @deprecated The flag is retired (410). Fails at once with `ENDPOINT_RETIRED`
 * and sends no request. Enterprise is set by a contract:
 * {@link useAdminCreateEnterpriseContract}. Removed in the next major.
 */
export function useAdminSetEnterpriseEntitled() {
  return useRetiredMutation<{ ok: boolean; enabled: boolean }, { accountId: string; enabled: boolean }>(
    'useAdminSetEnterpriseEntitled',
  );
}

/**
 * Merge-patch an account's entitlement overrides — the ONE route behind every
 * override, and the only one that can express an expiry.
 *
 * Send only the keys the form owns: an entry sets, `null` deletes, an absent
 * key is untouched.
 */
export function useAdminSetOverrides() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: boolean; overrides: AdminEntitlementOverrides },
    Error,
    { accountId: string; patch: AdminEntitlementOverridePatch }
  >({
    mutationFn: async ({ accountId, patch }) => {
      const response = await backendApi.put<{ ok: boolean; overrides: AdminEntitlementOverrides }>(
        adminAccountOverridesPath(accountId),
        patch,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: (_data, { accountId }) => invalidateAdminAccount(queryClient, accountId),
  });
}

export type AdminAccountMemberRole = 'owner' | 'admin' | 'member';

/** Wire path of the platform-admin member-role override route. */
export function adminMemberRolePath(accountId: string, userId: string): string {
  return `/admin/api/accounts/${accountId}/members/${userId}/role`;
}

/**
 * Platform-admin override of an account member's role. Bypasses the in-account
 * permission rules (which require the caller to be a member), but the server
 * still refuses to demote an account's last owner. Invalidates the account
 * subtree, which includes the users list the Users tab renders.
 */
export function useAdminSetMemberRole() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: boolean; user_id: string; account_role: string },
    Error,
    { accountId: string; userId: string; role: AdminAccountMemberRole }
  >({
    mutationFn: async ({ accountId, userId, role }) => {
      const response = await backendApi.post<{ ok: boolean; user_id: string; account_role: string }>(
        adminMemberRolePath(accountId, userId),
        { role },
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: (_data, { accountId }) => invalidateAdminAccount(queryClient, accountId),
  });
}

export interface AdminLedgerEntry {
  id: string;
  amount: string;
  balanceAfter: string;
  type: string;
  description: string | null;
  isExpiring: boolean | null;
  createdAt: string | null;
  createdBy: string | null;
}

export function useAdminAccountLedger(accountId: string | null, limit = 50) {
  return useQuery<{ entries: AdminLedgerEntry[] }>({
    queryKey: ['admin', 'accounts', accountId, 'ledger', limit],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<{ entries: AdminLedgerEntry[] }>(`/admin/api/accounts/${accountId}/ledger?limit=${limit}`);
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
}

export interface AdminAccountProject {
  projectId: string;
  name: string;
  status: string | null;
  repoUrl: string | null;
  defaultBranch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastOpenedAt: string | null;
  sessionCount: number;
  activeSessionCount: number;
  lastSessionAt: string | null;
}

export function useAdminAccountProjects(accountId: string | null) {
  return useQuery<{ projects: AdminAccountProject[] }>({
    queryKey: ['admin', 'accounts', accountId, 'projects'],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<{ projects: AdminAccountProject[] }>(
        `/admin/api/accounts/${accountId}/projects`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
}

/** @deprecated No replacement: the API removed this admin route. Fails with `ENDPOINT_RETIRED`, sends no request. Removed in the next major. */
export function useAdminAccountSandboxes(accountId: string | null) {
  return useRetiredQuery<{ sandboxes: AdminAccountSandbox[] }>('useAdminAccountSandboxes', ['admin', 'accounts', accountId, 'sandboxes'], !!accountId);
}

/**
 * The account's live Stripe subscription, exactly as Stripe reports it — what
 * the customer is ACTUALLY charged. The resolved plan badge describes the
 * stored tier (a legacy 'pro' row reads "Credits"); the
 * real subscription can be something else entirely (a $40/mo legacy machine
 * sub). The detail sheet renders both so the mismatch is visible.
 */
export interface AdminAccountSubscription {
  id: string;
  status: string;
  description: string | null;
  productName: string | null;
  priceId: string | null;
  unitAmountUsd: number | null;
  quantity: number;
  totalAmountUsd: number | null;
  interval: string | null;
  currency: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** Wire path of the admin live-subscription read. */
export function adminAccountSubscriptionPath(accountId: string): string {
  return `/admin/api/accounts/${encodeURIComponent(accountId)}/subscription`;
}

/** `subscription` is null when the account has no Stripe subscription on file. */
export function useAdminAccountSubscription(accountId: string | null) {
  return useQuery<{ subscription: AdminAccountSubscription | null }>({
    queryKey: ['admin', 'accounts', accountId, 'subscription'],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<{ subscription: AdminAccountSubscription | null }>(
        adminAccountSubscriptionPath(accountId!),
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: 60_000,
  });
}

// ─── Enterprise contracts ───────────────────────────────────────────────────
// The one way onto Enterprise: an annual license plus a prepaid credit pool.

const contractsKey = (accountId: string) => ['admin', 'account', accountId, 'enterprise-contracts'] as const;

async function adminCall<T>(call: Promise<{ data?: T | null; error?: { message: string } | null }>): Promise<T> {
  const response = await call;
  if (response.error) throw new Error(response.error.message);
  return response.data as T;
}

/** An account's Enterprise contracts, newest first. */
export function useAdminEnterpriseContracts(accountId: string | null | undefined) {
  return useQuery<{ contracts: AdminEnterpriseContract[] }, Error>({
    queryKey: contractsKey(accountId ?? ''),
    queryFn: () =>
      adminCall(backendApi.get<{ contracts: AdminEnterpriseContract[] }>(`/admin/api/accounts/${accountId}/enterprise-contracts`)),
    enabled: !!accountId,
  });
}

function onContractChange(queryClient: ReturnType<typeof useQueryClient>, accountId: string) {
  queryClient.invalidateQueries({ queryKey: contractsKey(accountId) });
  invalidateAdminAccount(queryClient, accountId);
}

/**
 * Create an Enterprise contract: `checkout` makes an offer the account's
 * billing managers accept in the app, `invoice` bills through a Stripe invoice
 * and activates at once, `manual` records a contract paid outside Stripe.
 */
export function useAdminCreateEnterpriseContract() {
  const queryClient = useQueryClient();
  return useMutation<{ contract: AdminEnterpriseContract }, Error, AdminCreateEnterpriseContractVariables>({
    mutationFn: ({ accountId, licenseUsd, creditsUsd, termMonths, collection, note }) => {
      void creditsUsd; // a license carries no credits
      const body: Record<string, unknown> = { license_usd: licenseUsd, collection };
      if (termMonths !== undefined) body.term_months = termMonths;
      if (note !== undefined) body.note = note;
      return adminCall(
        backendApi.post<{ contract: AdminEnterpriseContract }>(`/admin/api/accounts/${accountId}/enterprise-contract`, body),
      );
    },
    onSuccess: (_data, { accountId }) => onContractChange(queryClient, accountId),
  });
}

/** End the account's active contract now: the account returns to its base plan, SSO/SCIM kept for the grace. */
export function useAdminEndEnterpriseContract() {
  const queryClient = useQueryClient();
  return useMutation<{ contract: AdminEnterpriseContract }, Error, { accountId: string }>({
    mutationFn: ({ accountId }) =>
      adminCall(backendApi.post<{ contract: AdminEnterpriseContract }>(`/admin/api/accounts/${accountId}/enterprise-contract/end`, {})),
    onSuccess: (_data, { accountId }) => onContractChange(queryClient, accountId),
  });
}

/** Withdraw the account's open offer. */
export function useAdminWithdrawEnterpriseOffer() {
  const queryClient = useQueryClient();
  return useMutation<{ contract: AdminEnterpriseContract }, Error, { accountId: string }>({
    mutationFn: ({ accountId }) =>
      adminCall(backendApi.delete<{ contract: AdminEnterpriseContract }>(`/admin/api/accounts/${accountId}/enterprise-offer`)),
    onSuccess: (_data, { accountId }) => onContractChange(queryClient, accountId),
  });
}

/** A fresh Stripe Checkout link for the open offer, to send to the customer (valid up to 24 h). */
export function useAdminEnterpriseOfferLink() {
  return useMutation<{ checkout_url: string; contract_id: string }, Error, { accountId: string }>({
    mutationFn: ({ accountId }) =>
      adminCall(
        backendApi.post<{ checkout_url: string; contract_id: string }>(
          `/admin/api/accounts/${accountId}/enterprise-contract/checkout-link`,
          {},
        ),
      ),
  });
}
