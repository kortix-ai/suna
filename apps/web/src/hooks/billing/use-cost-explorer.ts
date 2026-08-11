import {
  getCostSummary,
  listCostByWorkspace,
  type CostSummary,
  type GetCostSummaryOptions,
  type ListCostByWorkspaceOptions,
  type WorkspaceCostPage,
  type WorkspaceCostSort,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useBillingAccountId } from '@/stores/billing-account-context';

/** Rows per page for the account-wide workspace cost rollup (`GET
 *  /usage/cost-by-workspace`) — mirrors `SESSION_COST_PAGE_SIZE` in
 *  `use-session-costs.ts`. */
export const COST_PAGE_SIZE = 25;
const COST_EXPLORER_STALE_TIME_MS = 30_000;

export interface CostExplorerSources {
  summary(options?: GetCostSummaryOptions): Promise<CostSummary>;
  byWorkspace(options?: ListCostByWorkspaceOptions): Promise<WorkspaceCostPage>;
}

const sdkSources: CostExplorerSources = {
  summary: getCostSummary,
  byWorkspace: listCostByWorkspace,
};

export interface CostSummaryQueryInput {
  accountId?: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  from?: string;
  to?: string;
}

export interface CostByWorkspaceQueryInput {
  accountId?: string;
  from?: string;
  to?: string;
  sort?: WorkspaceCostSort;
  offset: number;
}

/**
 * Account/workspace/session spend summary — powers the totals, trend series
 * and top-models breakdown at whichever level of the Workspace -> Sessions ->
 * Session drill-down the caller is on. The query key carries every scope
 * input (account, workspace, session, window) so switching levels or changing
 * the date window refetches instead of serving a stale page under the new
 * heading.
 */
export function buildCostSummaryQuery(
  input: CostSummaryQueryInput,
  sources: CostExplorerSources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    workspaceId: input.workspaceId ?? null,
    sessionId: input.sessionId ?? null,
    from: input.from,
    to: input.to,
  };
  const options: GetCostSummaryOptions = {
    accountId: input.accountId,
    workspaceId: input.workspaceId ?? undefined,
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
 * Account-wide workspace cost rollup — powers the top-level "by workspace" table
 * of the cost explorer. The query key carries the window, sort and offset so
 * paging, re-sorting or changing the date window all refetch.
 */
export function buildCostByWorkspaceQuery(
  input: CostByWorkspaceQueryInput,
  sources: CostExplorerSources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    from: input.from,
    to: input.to,
    sort: input.sort,
    offset: input.offset,
  };
  const options: ListCostByWorkspaceOptions = {
    accountId: input.accountId,
    from: input.from,
    to: input.to,
    sort: input.sort,
    limit: COST_PAGE_SIZE,
    offset: input.offset,
  };

  return {
    queryKey: ['cost-explorer', 'by-workspace', keyInput] as const,
    queryFn: () => sources.byWorkspace(options),
    enabled: Boolean(input.accountId),
    staleTime: COST_EXPLORER_STALE_TIME_MS,
  };
}

export function useCostSummary(input: {
  workspaceId?: string | null;
  sessionId?: string | null;
  from?: string;
  to?: string;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildCostSummaryQuery({
      accountId,
      workspaceId: input.workspaceId ?? null,
      sessionId: input.sessionId ?? null,
      from: input.from,
      to: input.to,
    }),
  );
}

export function useCostByWorkspace(input: {
  from?: string;
  to?: string;
  sort?: WorkspaceCostSort;
  offset: number;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildCostByWorkspaceQuery({
      accountId,
      from: input.from,
      to: input.to,
      sort: input.sort,
      offset: input.offset,
    }),
  );
}
