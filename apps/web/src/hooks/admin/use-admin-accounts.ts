import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

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

export interface AdminAuditEvent {
  id: string;
  created_at: string;
  ip_address: string | null;
  action: string | null;
  actor_id: string | null;
  actor_username: string | null;
  traits: Record<string, unknown> | null;
}

export interface AdminUsageEvent {
  id: string;
  amountDollars: string;
  description: string | null;
  usageType: string | null;
  subscriptionTier: string | null;
  createdAt: string | null;
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

export function useAdminAccountActivity(accountId: string | null, limit = 30) {
  return useQuery<{ auditEvents: AdminAuditEvent[]; usage: AdminUsageEvent[] }>({
    queryKey: ['admin', 'accounts', accountId, 'activity', limit],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<{
        auditEvents: AdminAuditEvent[];
        usage: AdminUsageEvent[];
      }>(`/admin/api/accounts/${accountId}/activity?limit=${limit}`);
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
}
