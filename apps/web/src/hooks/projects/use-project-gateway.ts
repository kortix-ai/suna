'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
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
  revokeGatewayKey,
  setGatewayBudget,
} from '@/lib/projects-gateway-client';
import { contract, qk } from '@kortix/sdk/react';

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

export function useGatewayLogs(projectId: string | undefined, opts?: { ok?: boolean }) {
  return useInfiniteQuery({
    queryKey: qk.project.gatewayLogs(projectId ?? '', opts?.ok ?? null),
    queryFn: ({ pageParam }) =>
      listGatewayLogs(projectId!, {
        ok: opts?.ok,
        limit: GATEWAY_LOGS_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    // The route hard-caps `limit` at 100 and hands back `next_offset` when more
    // rows exist. Reading only the first page (what this hook used to do) capped
    // the viewer at the 100 newest requests with nothing in the UI saying so.
    getNextPageParam: (last) => last.next_offset ?? undefined,
    enabled: !!projectId,
    // Live-tail only while the newest page is the ONLY page. An infinite query
    // refetches every loaded page on each tick, so polling after the reader has
    // paged back through history means N requests per interval and rows moving
    // under the keyboard cursor.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 1) > 1 ? false : 10_000),
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
