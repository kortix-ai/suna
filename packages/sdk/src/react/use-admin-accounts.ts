import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '../core/http/api-client';

/**
 * Lifecycle of an admin-issued trial. `active` is the only status that grants
 * the trial tier; every other value is history the row keeps for audit.
 * Mirrors `TRIAL_STATUS` in `apps/api/src/billing/services/effective-tier.ts`.
 */
export type AdminTrialStatus = 'none' | 'active' | 'expired' | 'revoked' | 'converted';

/** The trial overlay as the admin accounts list reports it. */
export interface AdminAccountTrial {
  status: AdminTrialStatus | string;
  /** Paid tier the trial emulates (never 'free'/'none'). */
  tier: string | null;
  seats: number | null;
  startedAt: string | null;
  endsAt: string | null;
  note: string | null;
}

export interface AdminAccount {
  accountId: string;
  name: string | null;
  ownerEmail: string | null;
  memberCount: number;
  balance: string | null;
  expiringCredits: string | null;
  nonExpiringCredits: string | null;
  dailyCreditsBalance: string | null;
  tier: string | null;
  paymentStatus: string | null;
  provider: string | null;
  planType: string | null;
  stripeSubscriptionId: string | null;
  billingCustomerId: string | null;
  billingCustomerEmail: string | null;
  createdAt: string | null;
  /** e.g. 'per_seat' — how the account is billed, independent of `tier`. */
  billingModel: string | null;
  seatCount: number | null;
  trial: AdminAccountTrial;
  /** null = the effective tier decides; true = force managed models; false = BYOK only. */
  managedModelsOverride: boolean | null;
  demoEnterprise: boolean;
  enterpriseEntitled: boolean;
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
 * mutations do: the paginated accounts list (the row carries `trial`,
 * `managedModelsOverride`, `demoEnterprise` and `enterpriseEntitled`) and the
 * per-account detail subtree.
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
  seats: number;
  durationDays: number;
  /** USD wallet credits granted with the trial (sandbox compute always debits the wallet). */
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
    mutationFn: async ({ accountId, tierKey, seats, durationDays, creditGrant, note }) => {
      const body: Record<string, unknown> = {
        tier_key: tierKey,
        seats,
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
 * Set the account's managed-models override. Tri-state: `null` restores "the
 * effective tier decides", `true` forces managed (Kortix-credential) models on,
 * `false` forces BYOK-only.
 */
export function useAdminSetManagedModels() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: boolean; override: boolean | null },
    Error,
    { accountId: string; override: boolean | null }
  >({
    mutationFn: async ({ accountId, override }) => {
      const response = await backendApi.post<{ ok: boolean; override: boolean | null }>(
        `/admin/api/accounts/${accountId}/managed-models`,
        { override },
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: (_data, { accountId }) => invalidateAdminAccount(queryClient, accountId),
  });
}

/**
 * Set the account's enterprise-demo flag — an interactive preview of SSO, SCIM,
 * RBAC and audit. Operator-only since the self-serve IAM toggle was retired.
 */
export function useAdminSetEnterpriseDemo() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: boolean; enabled: boolean },
    Error,
    { accountId: string; enabled: boolean }
  >({
    mutationFn: async ({ accountId, enabled }) => {
      const response = await backendApi.post<{ ok: boolean; enabled: boolean }>(
        `/admin/api/accounts/${accountId}/enterprise-demo`,
        { enabled },
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: (_data, { accountId }) => invalidateAdminAccount(queryClient, accountId),
  });
}

/**
 * Set the contracted-Enterprise entitlement flag. Independent of `tier`: it
 * keeps SSO/SCIM/RBAC/audit entitled for a signed Enterprise account that is
 * ALSO per-seat billed, which the Stripe webhook would otherwise reconcile away.
 */
export function useAdminSetEnterpriseEntitled() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: boolean; enabled: boolean },
    Error,
    { accountId: string; enabled: boolean }
  >({
    mutationFn: async ({ accountId, enabled }) => {
      const response = await backendApi.post<{ ok: boolean; enabled: boolean }>(
        `/admin/api/accounts/${accountId}/enterprise-entitlement`,
        { enabled },
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

export interface AdminAccountWorkspace {
  workspaceId: string;
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

/** @deprecated Use `AdminAccountWorkspace`. */
export type AdminAccountProject = AdminAccountWorkspace;

export function useAdminAccountWorkspaces(accountId: string | null) {
  return useQuery<{ workspaces: AdminAccountWorkspace[] }>({
    queryKey: ['admin', 'accounts', accountId, 'workspaces'],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<{ workspaces: AdminAccountWorkspace[] }>(
        `/admin/api/accounts/${accountId}/workspaces`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
}

/** @deprecated Use `useAdminAccountWorkspaces`. */
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

export function useAdminAccountSandboxes(accountId: string | null) {
  return useQuery<{ sandboxes: AdminAccountSandbox[] }>({
    queryKey: ['admin', 'accounts', accountId, 'sandboxes'],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<{ sandboxes: AdminAccountSandbox[] }>(
        `/admin/api/accounts/${accountId}/sandboxes`,
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
}
