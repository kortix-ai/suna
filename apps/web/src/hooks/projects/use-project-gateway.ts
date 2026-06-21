'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
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
  runGatewayPlayground,
  setGatewayBudget,
  type SetGatewayBudgetInput,
} from '@/lib/projects-gateway-client';

export function useGatewayOverview(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['project-gateway-overview', projectId, days],
    queryFn: () => getGatewayOverview(projectId!, days),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useGatewaySeries(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['project-gateway-series', projectId, days],
    queryFn: () => getGatewaySeries(projectId!, days),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useGatewayBreakdown(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['project-gateway-breakdown', projectId, days],
    queryFn: () => getGatewayBreakdown(projectId!, days),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useGatewaySessions(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['project-gateway-sessions', projectId, days],
    queryFn: () => getGatewaySessions(projectId!, days),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useGatewayErrors(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['project-gateway-errors', projectId, days],
    queryFn: () => getGatewayErrors(projectId!, days),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useGatewayLogs(projectId: string | undefined, opts?: { ok?: boolean }) {
  return useQuery({
    queryKey: ['project-gateway-logs', projectId, opts?.ok ?? null],
    queryFn: () => listGatewayLogs(projectId!, { ok: opts?.ok, limit: 100 }),
    enabled: !!projectId,
    refetchInterval: 10_000,
  });
}

export function useGatewayLog(projectId: string | undefined, logId: string | null) {
  return useQuery({
    queryKey: ['project-gateway-log', projectId, logId],
    queryFn: () => getGatewayLog(projectId!, logId!),
    enabled: !!projectId && !!logId,
  });
}

export function useGatewayBudgets(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project-gateway-budgets', projectId],
    queryFn: () => getGatewayBudgets(projectId!),
    enabled: !!projectId,
    staleTime: 15_000,
  });
}

export function useSetGatewayBudget(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetGatewayBudgetInput) => setGatewayBudget(projectId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-gateway-budgets', projectId] }),
  });
}

export function useDeleteGatewayBudget(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (budgetId: string) => deleteGatewayBudget(projectId!, budgetId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-gateway-budgets', projectId] }),
  });
}

export function useGatewayKeys(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['project-gateway-keys', projectId],
    queryFn: () => getGatewayKeys(projectId!),
    enabled: !!projectId && enabled,
    staleTime: 15_000,
  });
}

export function useCreateGatewayKey(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createGatewayKey(projectId!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-gateway-keys', projectId] }),
  });
}

export function useRevokeGatewayKey(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => revokeGatewayKey(projectId!, keyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-gateway-keys', projectId] }),
  });
}

export function useGatewayPlayground(projectId: string | undefined) {
  return useMutation({
    mutationFn: ({ prompt, models }: { prompt: string; models: string[] }) =>
      runGatewayPlayground(projectId!, prompt, models),
  });
}
