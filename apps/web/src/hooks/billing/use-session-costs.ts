import {
  getSessionCostRecord,
  listProjectsForAccount,
  listSessionCosts,
  type GetSessionCostRecordOptions,
  type KortixProject,
  type ListSessionCostsOptions,
  type SessionCostDetail,
  type SessionCostsPage,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useBillingAccountId } from '@/stores/billing-account-context';

export const SESSION_COST_PAGE_SIZE = 25;
const SESSION_COST_STALE_TIME_MS = 30_000;

export interface SessionCostQuerySources {
  list(options?: ListSessionCostsOptions): Promise<SessionCostsPage>;
  get(sessionId: string, options?: GetSessionCostRecordOptions): Promise<SessionCostDetail>;
  projects(accountId?: string): Promise<KortixProject[]>;
}

const sdkSources: SessionCostQuerySources = {
  list: listSessionCosts,
  get: getSessionCostRecord,
  projects: listProjectsForAccount,
};

export interface SessionCostsListInput {
  accountId?: string;
  projectId?: string | null;
  limit: number;
  offset: number;
}

export interface SessionCostDetailInput {
  accountId?: string;
  projectId?: string | null;
  sessionId?: string | null;
}

export function buildSessionCostsListQuery(
  input: SessionCostsListInput,
  sources: SessionCostQuerySources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    projectId: input.projectId ?? null,
    limit: input.limit,
    offset: input.offset,
  };
  const options: ListSessionCostsOptions = {
    accountId: input.accountId,
    projectId: input.projectId ?? undefined,
    limit: input.limit,
    offset: input.offset,
  };

  return {
    queryKey: ['session-costs', 'list', keyInput] as const,
    queryFn: () => sources.list(options),
    staleTime: SESSION_COST_STALE_TIME_MS,
  };
}

export function buildSessionCostDetailQuery(
  input: SessionCostDetailInput,
  sources: SessionCostQuerySources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    projectId: input.projectId ?? null,
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
        projectId: input.projectId ?? undefined,
      });
    },
    enabled: Boolean(input.sessionId),
    staleTime: SESSION_COST_STALE_TIME_MS,
  };
}

export function buildSessionCostProjectsQuery(
  accountId: string | undefined,
  sources: SessionCostQuerySources = sdkSources,
) {
  return {
    queryKey: ['session-costs', 'projects', accountId ?? null] as const,
    queryFn: () => sources.projects(accountId),
    staleTime: SESSION_COST_STALE_TIME_MS,
  };
}

export function resetSessionCostProjectFilter(
  current: { projectId: string | null; offset: number },
  projectId: string | null,
) {
  if (current.projectId === projectId) return current;
  return { projectId, offset: 0 };
}

export function useSessionCosts(input: {
  projectId: string | null;
  limit?: number;
  offset: number;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildSessionCostsListQuery({
      accountId,
      projectId: input.projectId,
      limit: input.limit ?? SESSION_COST_PAGE_SIZE,
      offset: input.offset,
    }),
  );
}

export function useSessionCostDetail(input: {
  projectId: string | null;
  sessionId: string | null;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildSessionCostDetailQuery({
      accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
    }),
  );
}

export function useSessionCostProjects() {
  const accountId = useBillingAccountId();
  return useQuery(buildSessionCostProjectsQuery(accountId));
}
