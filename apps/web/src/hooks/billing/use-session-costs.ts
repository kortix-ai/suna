import {
  getSessionCostRecord,
  listWorkspacesForAccount,
  listSessionCosts,
  type GetSessionCostRecordOptions,
  type KortixWorkspace,
  type ListSessionCostsOptions,
  type SessionCostDetail,
  type SessionCostSort,
  type SessionCostsPage,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useBillingAccountId } from '@/stores/billing-account-context';

export const SESSION_COST_PAGE_SIZE = 25;
const SESSION_COST_STALE_TIME_MS = 30_000;

export interface SessionCostQuerySources {
  list(options?: ListSessionCostsOptions): Promise<SessionCostsPage>;
  get(sessionId: string, options?: GetSessionCostRecordOptions): Promise<SessionCostDetail>;
  workspaces(accountId?: string): Promise<KortixWorkspace[]>;
}

const sdkSources: SessionCostQuerySources = {
  list: listSessionCosts,
  get: getSessionCostRecord,
  workspaces: listWorkspacesForAccount,
};

export interface SessionCostsListInput {
  accountId?: string;
  workspaceId?: string | null;
  limit: number;
  offset: number;
  from?: string;
  to?: string;
  sort?: SessionCostSort;
  /** Filter to sessions owned by this user/service-account id. */
  ownerId?: string;
}

export interface SessionCostDetailInput {
  accountId?: string;
  workspaceId?: string | null;
  sessionId?: string | null;
}

export function buildSessionCostsListQuery(
  input: SessionCostsListInput,
  sources: SessionCostQuerySources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    workspaceId: input.workspaceId ?? null,
    limit: input.limit,
    offset: input.offset,
    from: input.from,
    to: input.to,
    sort: input.sort,
    ownerId: input.ownerId,
  };
  const options: ListSessionCostsOptions = {
    accountId: input.accountId,
    workspaceId: input.workspaceId ?? undefined,
    ownerId: input.ownerId,
    sort: input.sort,
    from: input.from,
    to: input.to,
    limit: input.limit,
    offset: input.offset,
  };

  return {
    queryKey: ['session-costs', 'list', keyInput] as const,
    queryFn: () => sources.list(options),
    enabled: Boolean(input.accountId),
    staleTime: SESSION_COST_STALE_TIME_MS,
  };
}

export function buildSessionCostDetailQuery(
  input: SessionCostDetailInput,
  sources: SessionCostQuerySources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    workspaceId: input.workspaceId ?? null,
    sessionId: input.sessionId ?? null,
  };

  return {
    queryKey: ['session-costs', 'detail', keyInput] as const,
    queryFn: () => {
      if (!input.sessionId) {
        throw new Error('A session is required to load cost details.');
      }
      return sources.get(input.sessionId, {
        accountId: input.accountId,
        workspaceId: input.workspaceId ?? undefined,
      });
    },
    // Requires an account id too, not just a session id: getSessionCostRecord's
    // scope options (`appendScopeOptions` in the SDK) only set `account_id` when
    // truthy, and the API's session-costs detail route falls back to
    // resolveScopedAccountId -> the caller's PRIMARY account when the query
    // omits it. Firing before useBillingAccountId() resolves would silently
    // query the wrong account (a 404 today, since getSessionCostRecord ANDs
    // accountId with sessionId server-side — but relying on that AND as a
    // safety net is fragile, and it still means a spurious "not found" flash
    // for the exact session the user is looking at).
    enabled: Boolean(input.sessionId) && Boolean(input.accountId),
    staleTime: SESSION_COST_STALE_TIME_MS,
  };
}

export function buildSessionCostWorkspacesQuery(
  accountId: string | undefined,
  sources: SessionCostQuerySources = sdkSources,
) {
  return {
    queryKey: ['session-costs', 'workspaces', accountId ?? null] as const,
    queryFn: () => sources.workspaces(accountId),
    staleTime: SESSION_COST_STALE_TIME_MS,
  };
}

export function resetSessionCostWorkspaceFilter(
  current: { workspaceId: string | null; offset: number },
  workspaceId: string | null,
) {
  if (current.workspaceId === workspaceId) return current;
  return { workspaceId, offset: 0 };
}

export function useSessionCosts(input: {
  workspaceId: string | null;
  limit?: number;
  offset: number;
  from?: string;
  to?: string;
  sort?: SessionCostSort;
  ownerId?: string;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildSessionCostsListQuery({
      accountId,
      workspaceId: input.workspaceId,
      limit: input.limit ?? SESSION_COST_PAGE_SIZE,
      offset: input.offset,
      from: input.from,
      to: input.to,
      sort: input.sort,
      ownerId: input.ownerId,
    }),
  );
}

export function useSessionCostDetail(input: {
  workspaceId: string | null;
  sessionId: string | null;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildSessionCostDetailQuery({
      accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    }),
  );
}

export function useSessionCostWorkspaces() {
  const accountId = useBillingAccountId();
  return useQuery(buildSessionCostWorkspacesQuery(accountId));
}
