'use client';

/**
 * Customize is ready before anyone opens it.
 *
 * Every Customize tab fetched its data on first open: Agents, Connectors,
 * Triggers, Secrets, Review, Models and Settings each waited 0.6–2.2 s on the
 * API (dev-api, 2026-09-26, `Server-Timing`) while the page showed a skeleton.
 * The data does not depend on which tab is open, so the project shell fills the
 * React Query cache once, in the background, on the first idle slot after the
 * project loads. Opening a tab then renders from memory; React Query
 * revalidates stale entries behind the rendered data.
 *
 * Rules:
 *  - Same key, fetch function and freshness as the page that reads the entry.
 *    A different staleTime or key would make the page refetch anyway.
 *  - Only what the caller may read. The gates are the probes the shell already
 *    batches (`PROJECT_PAGE_ACTIONS`), so the prefetch adds no IAM request.
 *  - `prefetchQuery` never throws and skips an entry that is still fresh.
 *  - A longer `gcTime` keeps the entries through a long session on another
 *    route; the default five minutes would drop them before Customize opens.
 */

import {
  getModelDefaults,
  getProject,
  getProjectDetail,
  getProjectModelPicker,
  listConnectors,
  listProjectBranches,
  listProjectResourceGrants,
  listProjectSandboxTemplates,
  listProjectSecrets,
  listProjectSnapshots,
  listProjectTriggers,
  listReviewItems,
} from '@kortix/sdk';
import { contract, FRESHNESS, qk } from '@kortix/sdk/react';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectPageCans } from '../../internal/lib/use-project-can';

/** Keep prefetched Customize data for half an hour without an observer. */
export const CUSTOMIZE_PREFETCH_GC_MS = 30 * 60_000;
/** Upper bound on waiting for an idle browser before prefetching anyway. */
const IDLE_TIMEOUT_MS = 1_000;

export interface CustomizePrefetchGates {
  /** project.agent.read — the landing tab; nothing is prefetched without it. */
  agentRead: boolean;
  /** project.sandbox.write — Settings → Git and Sandbox. */
  sandboxWrite: boolean;
  /** project.model.read — the Models tab's reads. */
  modelRead: boolean;
  connectorRead: boolean;
  triggerRead: boolean;
  secretRead: boolean;
  reviewRead: boolean;
  membersManage: boolean;
}

type CatalogQueries = Pick<
  typeof import('../connectors/catalog/use-catalog'),
  'catalogSectionsQuery'
>;

/** The reads the prefetch issues. Injected in tests; the SDK in production. */
export interface CustomizePrefetchApi {
  getProject: typeof getProject;
  getModelDefaults: typeof getModelDefaults;
  getProjectModelPicker: typeof getProjectModelPicker;
  listConnectors: typeof listConnectors;
  listProjectBranches: typeof listProjectBranches;
  listProjectResourceGrants: typeof listProjectResourceGrants;
  listProjectSandboxTemplates: typeof listProjectSandboxTemplates;
  listProjectSecrets: typeof listProjectSecrets;
  listProjectSnapshots: typeof listProjectSnapshots;
  listProjectTriggers: typeof listProjectTriggers;
  listReviewItems: typeof listReviewItems;
  /** Loaded on idle, not with the shell: it also warms the Connectors chunk. */
  loadCatalogQueries: () => Promise<CatalogQueries>;
}

const sdkApi: CustomizePrefetchApi = {
  getProject,
  getModelDefaults,
  getProjectModelPicker,
  listConnectors,
  listProjectBranches,
  listProjectResourceGrants,
  listProjectSandboxTemplates,
  listProjectSecrets,
  listProjectSnapshots,
  listProjectTriggers,
  listReviewItems,
  loadCatalogQueries: () =>
    import('../connectors/catalog/use-catalog'),
};

/**
 * Warm every Customize entry the caller may read. The hook below decides
 * when; this decides what.
 */
export async function prefetchCustomize(
  queryClient: QueryClient,
  projectId: string,
  gates: CustomizePrefetchGates,
  api: CustomizePrefetchApi = sdkApi,
): Promise<void> {
  if (!gates.agentRead) return;
  const gc = { gcTime: CUSTOMIZE_PREFETCH_GC_MS };
  const config = { ...contract('config'), ...gc };
  const work: Promise<unknown>[] = [
    // `useProjectCan` without an account hint resolves the owning account from
    // this entry before its probe can start (`@kortix/sdk/react` use-can.ts).
    // Warm, every such gate on every tab skips that extra round trip.
    queryClient.prefetchQuery({
      queryKey: qk.project.summary(projectId),
      queryFn: () => api.getProject(projectId),
      ...config,
    }),
  ];

  if (gates.triggerRead) {
    work.push(
      queryClient.prefetchQuery({
        queryKey: qk.project.triggers(projectId),
        queryFn: () => api.listProjectTriggers(projectId),
        ...config,
      }),
    );
  }
  if (gates.connectorRead) {
    work.push(
      queryClient.prefetchQuery({
        queryKey: qk.project.connectors(projectId),
        queryFn: () => api.listConnectors(projectId, { includeSchemas: false }),
        ...contract(FRESHNESS.connectors),
        ...gc,
      }),
      prefetchCatalogLanding(queryClient, projectId, api),
    );
  }
  if (gates.secretRead) {
    work.push(
      queryClient.prefetchQuery({
        queryKey: qk.project.secrets(projectId),
        queryFn: () => api.listProjectSecrets(projectId),
        ...config,
      }),
    );
  }
  if (gates.reviewRead) {
    // Same entry and freshness as `useReviewItems`: the first page of the
    // segment the Review tab opens on.
    work.push(
      queryClient.prefetchInfiniteQuery({
        queryKey: qk.project.reviewItemPages(projectId, { segment: 'needs_you' }),
        queryFn: ({ pageParam }) =>
          api.listReviewItems(projectId, { segment: 'needs_you', cursor: pageParam }),
        initialPageParam: undefined as string | undefined,
        staleTime: 5_000,
        ...gc,
      }),
    );
  }
  if (gates.membersManage) {
    // Agents list: the people count on each card.
    work.push(
      queryClient.prefetchQuery({
        queryKey: qk.project.resourceGrants(projectId),
        queryFn: () => api.listProjectResourceGrants(projectId),
        ...contract('inventory'),
        ...gc,
      }),
    );
  }
  if (gates.modelRead) {
    // Models: the entries `useProjectModels` and `useModelDefaults` read.
    work.push(
      queryClient.prefetchQuery({
        queryKey: qk.project.modelPicker(projectId),
        queryFn: () => api.getProjectModelPicker(projectId),
        ...config,
      }),
      queryClient.prefetchQuery({
        queryKey: ['model-defaults', projectId],
        queryFn: () => api.getModelDefaults(projectId),
        staleTime: 30_000,
        ...gc,
      }),
    );
  }
  if (gates.sandboxWrite) {
    // Settings → Git and Sandbox, and the agent editor's sandbox picker
    // (same entry as `agentEditorOptionQueries(...).sandboxes`).
    work.push(
      queryClient.prefetchQuery({
        queryKey: qk.project.sandboxTemplates(projectId),
        queryFn: () => api.listProjectSandboxTemplates(projectId),
        ...config,
      }),
      queryClient.prefetchQuery({
        queryKey: qk.project.snapshots(projectId),
        queryFn: () => api.listProjectSnapshots(projectId),
        ...config,
      }),
      queryClient.prefetchQuery({
        queryKey: qk.project.branches(projectId),
        queryFn: () => api.listProjectBranches(projectId, { includeSessionBranches: false }),
        ...config,
      }),
    );
  }
  await Promise.all(work);
}

/**
 * Connectors → the catalogue's landing sections, as the page opens it: One-click
 * only on, no type filter (`ConnectorsPage`). Same key as `useCatalog`.
 */
async function prefetchCatalogLanding(
  queryClient: QueryClient,
  projectId: string,
  api: CustomizePrefetchApi,
): Promise<void> {
  const catalog = await api.loadCatalogQueries().catch(() => null);
  if (!catalog) return;
  await queryClient.prefetchQuery({
    ...catalog.catalogSectionsQuery(projectId, true),
    gcTime: CUSTOMIZE_PREFETCH_GC_MS,
  });
}

function whenIdle(run: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, IDLE_TIMEOUT_MS);
  return () => window.clearTimeout(handle);
}

/**
 * Mounted once by the project shell. Waits for project detail (every
 * Customize page reads it, and the shell already fetches it) and the shared
 * permission batch, then prefetches once per project on the next idle slot.
 */
export function useCustomizePrefetch(projectId: string): void {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const caps = useProjectPageCans(projectId);

  const allowed = (action: string) => caps[action]?.allowed === true;
  const settled = Object.values(caps).every((probe) => !probe.isLoading);
  const ready = !!projectId && detail.isSuccess && settled;
  const agentRead = allowed(PROJECT_ACTIONS.PROJECT_AGENT_READ);
  const sandboxWrite = allowed(PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE);
  const modelRead = allowed(PROJECT_ACTIONS.PROJECT_MODEL_READ);
  const connectorRead = allowed(PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);
  const triggerRead = allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_READ);
  const secretRead = allowed(PROJECT_ACTIONS.PROJECT_SECRET_READ);
  const reviewRead = allowed(PROJECT_ACTIONS.PROJECT_REVIEW_READ);
  const membersManage = allowed(PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);
  const gates = useMemo<CustomizePrefetchGates>(
    () => ({
      agentRead,
      sandboxWrite,
      modelRead,
      connectorRead,
      triggerRead,
      secretRead,
      reviewRead,
      membersManage,
    }),
    [
      agentRead,
      sandboxWrite,
      modelRead,
      connectorRead,
      triggerRead,
      secretRead,
      reviewRead,
      membersManage,
    ],
  );

  useEffect(() => {
    if (!ready) return;
    return whenIdle(() => {
      void prefetchCustomize(queryClient, projectId, gates);
    });
  }, [ready, gates, projectId, queryClient]);
}
