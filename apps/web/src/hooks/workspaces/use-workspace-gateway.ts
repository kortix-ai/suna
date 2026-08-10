'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type GatewayModelGenerationConfig,
  type GatewayPlaygroundResponse,
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
  runGatewayPlayground,
  setGatewayBudget,
} from '@/lib/workspaces-gateway-client';
import { contract, qk } from '@kortix/sdk/react';

export function useGatewayOverview(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.workspace.gatewayOverview(workspaceId ?? '', days),
    queryFn: () => getGatewayOverview(workspaceId!, days),
    enabled: !!workspaceId,
    ...contract('inventory'),
  });
}

export function useGatewaySeries(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.workspace.gatewaySeries(workspaceId ?? '', days),
    queryFn: () => getGatewaySeries(workspaceId!, days),
    enabled: !!workspaceId,
    ...contract('inventory'),
  });
}

export function useGatewayBreakdown(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.workspace.gatewayBreakdown(workspaceId ?? '', days),
    queryFn: () => getGatewayBreakdown(workspaceId!, days),
    enabled: !!workspaceId,
    ...contract('inventory'),
  });
}

export function useGatewaySessions(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.workspace.gatewaySessions(workspaceId ?? '', days),
    queryFn: () => getGatewaySessions(workspaceId!, days),
    enabled: !!workspaceId,
    ...contract('inventory'),
  });
}

export function useGatewayErrors(workspaceId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.workspace.gatewayErrors(workspaceId ?? '', days),
    queryFn: () => getGatewayErrors(workspaceId!, days),
    enabled: !!workspaceId,
    ...contract('inventory'),
  });
}

export function useGatewayLogs(workspaceId: string | undefined, opts?: { ok?: boolean }) {
  return useQuery({
    queryKey: qk.workspace.gatewayLogs(workspaceId ?? '', opts?.ok ?? null),
    queryFn: () => listGatewayLogs(workspaceId!, { ok: opts?.ok, limit: 100 }),
    enabled: !!workspaceId,
    refetchInterval: 10_000,
  });
}

export function useGatewayLog(workspaceId: string | undefined, logId: string | null) {
  return useQuery({
    queryKey: qk.workspace.gatewayLog(workspaceId ?? '', logId),
    queryFn: () => getGatewayLog(workspaceId!, logId!),
    enabled: !!workspaceId && !!logId,
  });
}

export function useGatewayBudgets(workspaceId: string | undefined) {
  return useQuery({
    queryKey: qk.workspace.gatewayBudgets(workspaceId ?? ''),
    queryFn: () => getGatewayBudgets(workspaceId!),
    enabled: !!workspaceId,
    ...contract('inventory'),
  });
}

export function useSetGatewayBudget(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetGatewayBudgetInput) => setGatewayBudget(workspaceId!, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.workspace.gatewayBudgets(workspaceId ?? '') }),
  });
}

export function useDeleteGatewayBudget(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (budgetId: string) => deleteGatewayBudget(workspaceId!, budgetId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.workspace.gatewayBudgets(workspaceId ?? '') }),
  });
}

export function useGatewayKeys(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.workspace.gatewayKeys(workspaceId ?? ''),
    queryFn: () => getGatewayKeys(workspaceId!),
    enabled: !!workspaceId && enabled,
    ...contract('inventory'),
  });
}

export function useCreateGatewayKey(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createGatewayKey(workspaceId!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.workspace.gatewayKeys(workspaceId ?? '') }),
  });
}

export function useRevokeGatewayKey(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => revokeGatewayKey(workspaceId!, keyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.workspace.gatewayKeys(workspaceId ?? '') }),
  });
}

export interface RunGatewayPlaygroundInput {
  prompt: string;
  models: string[];
  system?: string;
  /** Per-model generation-parameter overrides for this run only — see
   *  `runGatewayPlayground`'s doc comment. */
  generationConfig?: Record<string, GatewayModelGenerationConfig>;
}

/** Run one prompt across up to 6 models side by side — no cache, always a fresh run. */
export function useGatewayPlayground(workspaceId: string | undefined) {
  return useMutation<GatewayPlaygroundResponse, Error, RunGatewayPlaygroundInput>({
    mutationFn: ({ prompt, models, system, generationConfig }) =>
      runGatewayPlayground(workspaceId!, prompt, models, system, generationConfig),
  });
}
