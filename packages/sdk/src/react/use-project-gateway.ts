'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type GatewayLogFilters,
  type SetGatewayBudgetInput,
  createGatewayKey,
  deleteGatewayBudget,
  getGatewayBreakdown,
  getGatewayBudgets,
  getGatewayErrors,
  getGatewayKeys,
  getGatewayLog,
  getGatewayOverview,
  getGatewaySeries,
  getGatewaySessions,
  listGatewayLogs,
  getGatewayLogFacets,
  revokeGatewayKey,
  setGatewayBudget,
} from '../core/rest/projects-client/gateway';
import { contract } from './query-contracts';
import { qk } from './query-keys';

export function useGatewayOverview(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewayOverview(projectId ?? '', days),
    queryFn: () => getGatewayOverview(projectId!, days),
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

export function useGatewaySeries(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewaySeries(projectId ?? '', days),
    queryFn: () => getGatewaySeries(projectId!, days),
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

export function useGatewayBreakdown(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewayBreakdown(projectId ?? '', days),
    queryFn: () => getGatewayBreakdown(projectId!, days),
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

export function useGatewaySessions(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewaySessions(projectId ?? '', days),
    queryFn: () => getGatewaySessions(projectId!, days),
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

export function useGatewayErrors(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewayErrors(projectId ?? '', days),
    queryFn: () => getGatewayErrors(projectId!, days),
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

/** Matches the route's `LIST_LIMIT_MAX`, so one click pulls a full server page. */
export const GATEWAY_LOGS_PAGE_SIZE = 100;

export function useGatewayLogs(projectId: string | undefined, opts?: GatewayLogFilters) {
  const { ok, ...rest } = opts ?? {};
  // Blank filters are no filter: the same key, the same cache entry.
  const filters = Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v === 'string' && v.trim()));
  const filtered = Object.keys(filters).length > 0;
  return useInfiniteQuery({
    queryKey: qk.project.gatewayLogs(projectId ?? '', ok ?? null, filtered ? filters : undefined),
    queryFn: ({ pageParam }) =>
      listGatewayLogs(projectId!, {
        ...filters,
        ok,
        limit: GATEWAY_LOGS_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    // The route hard-caps `limit` at 100 and hands back `next_offset` when more
    // rows exist. Reading only the first page (what this hook used to do) capped
    // the viewer at the 100 newest requests with nothing in the UI saying so.
    getNextPageParam: (last) => last.next_offset ?? undefined,
    enabled: !!projectId,
    // A new filter keeps the rows on screen until its own first page lands.
    placeholderData: (previous) => previous,
    // Live-tail only while the newest page is the ONLY page. An infinite query
    // refetches every loaded page on each tick, so polling after the reader has
    // paged back through history means N requests per interval and rows moving
    // under the keyboard cursor. A window that ends in the past never changes.
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 1) > 1 || filters.until ? false : 10_000,
  });
}

/** The values the log filters can take in the last `hours` (default 24), the most-used first. */
export function useGatewayLogFacets(projectId: string | undefined, hours = 24) {
  return useQuery({
    queryKey: qk.project.gatewayLogFacets(projectId ?? '', hours),
    queryFn: () => getGatewayLogFacets(projectId!, { hours }),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

export function useGatewayLog(projectId: string | undefined, logId: string | null) {
  return useQuery({
    queryKey: qk.project.gatewayLog(projectId ?? '', logId),
    queryFn: () => getGatewayLog(projectId!, logId!),
    enabled: !!projectId && !!logId,
  });
}

export function useGatewayBudgets(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.project.gatewayBudgets(projectId ?? ''),
    queryFn: () => getGatewayBudgets(projectId!),
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

export function useSetGatewayBudget(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetGatewayBudgetInput) => setGatewayBudget(projectId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project.gatewayBudgets(projectId ?? '') }),
  });
}

export function useDeleteGatewayBudget(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (budgetId: string) => deleteGatewayBudget(projectId!, budgetId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project.gatewayBudgets(projectId ?? '') }),
  });
}

export function useGatewayKeys(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.project.gatewayKeys(projectId ?? ''),
    queryFn: () => getGatewayKeys(projectId!),
    enabled: !!projectId && enabled,
    ...contract('inventory'),
  });
}

export function useCreateGatewayKey(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createGatewayKey(projectId!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project.gatewayKeys(projectId ?? '') }),
  });
}

export function useRevokeGatewayKey(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => revokeGatewayKey(projectId!, keyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project.gatewayKeys(projectId ?? '') }),
  });
}

// The Playground's `useGatewayPlayground` hook lived here. Its one consumer,
// `gateway-playground.tsx`, is deleted — a prompt box that fanned one message
// across models, next to a product whose entire surface is a session that does
// the same thing with the real runtime behind it. The transport
// (`runGatewayPlayground`) and the API route it calls are untouched; only this
// unused React binding is gone.
