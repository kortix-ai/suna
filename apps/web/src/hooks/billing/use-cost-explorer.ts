import {
  getCostSummary,
  listCostByProject,
  type CostSummary,
  type GetCostSummaryOptions,
  type ListCostByProjectOptions,
  type ProjectCostPage,
  type ProjectCostSort,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useBillingAccountId } from '@/stores/billing-account-context';

/** Rows per page for the account-wide project cost rollup (`GET
 *  /usage/cost-by-project`) — mirrors `SESSION_COST_PAGE_SIZE` in
 *  `use-session-costs.ts`. */
export const COST_PAGE_SIZE = 25;
const COST_EXPLORER_STALE_TIME_MS = 30_000;

export interface CostExplorerSources {
  summary(options?: GetCostSummaryOptions): Promise<CostSummary>;
  byProject(options?: ListCostByProjectOptions): Promise<ProjectCostPage>;
}

const sdkSources: CostExplorerSources = {
  summary: getCostSummary,
  byProject: listCostByProject,
};

export interface CostSummaryQueryInput {
  accountId?: string;
  projectId?: string | null;
  sessionId?: string | null;
  from?: string;
  to?: string;
}

export interface CostByProjectQueryInput {
  accountId?: string;
  from?: string;
  to?: string;
  sort?: ProjectCostSort;
  offset: number;
}

/**
 * Account/project/session spend summary — powers the totals, trend series
 * and top-models breakdown at whichever level of the Project -> Sessions ->
 * Session drill-down the caller is on. The query key carries every scope
 * input (account, project, session, window) so switching levels or changing
 * the date window refetches instead of serving a stale page under the new
 * heading.
 */
export function buildCostSummaryQuery(
  input: CostSummaryQueryInput,
  sources: CostExplorerSources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    from: input.from,
    to: input.to,
  };
  const options: GetCostSummaryOptions = {
    accountId: input.accountId,
    projectId: input.projectId ?? undefined,
    sessionId: input.sessionId ?? undefined,
    from: input.from,
    to: input.to,
  };

  return {
    queryKey: ['cost-explorer', 'summary', keyInput] as const,
    queryFn: () => sources.summary(options),
    enabled: Boolean(input.accountId),
    staleTime: COST_EXPLORER_STALE_TIME_MS,
  };
}

/**
 * Account-wide project cost rollup — powers the top-level "by project" table
 * of the cost explorer. The query key carries the window, sort and offset so
 * paging, re-sorting or changing the date window all refetch.
 */
export function buildCostByProjectQuery(
  input: CostByProjectQueryInput,
  sources: CostExplorerSources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    from: input.from,
    to: input.to,
    sort: input.sort,
    offset: input.offset,
  };
  const options: ListCostByProjectOptions = {
    accountId: input.accountId,
    from: input.from,
    to: input.to,
    sort: input.sort,
    limit: COST_PAGE_SIZE,
    offset: input.offset,
  };

  return {
    queryKey: ['cost-explorer', 'by-project', keyInput] as const,
    queryFn: () => sources.byProject(options),
    enabled: Boolean(input.accountId),
    staleTime: COST_EXPLORER_STALE_TIME_MS,
  };
}

export function useCostSummary(input: {
  projectId?: string | null;
  sessionId?: string | null;
  from?: string;
  to?: string;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildCostSummaryQuery({
      accountId,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      from: input.from,
      to: input.to,
    }),
  );
}

export function useCostByProject(input: {
  from?: string;
  to?: string;
  sort?: ProjectCostSort;
  offset: number;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildCostByProjectQuery({
      accountId,
      from: input.from,
      to: input.to,
      sort: input.sort,
      offset: input.offset,
    }),
  );
}
