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
} from '@/lib/projects-gateway-client';
import { contract, qk } from '@kortix/sdk/react';

export function useGatewayOverview(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewayOverview(projectId ?? '', days),
    queryFn: () => getGatewayOverview(projectId!, days),
    enabled: !!projectId,
    ...contract('volatile'),
  });
}

export function useGatewaySeries(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewaySeries(projectId ?? '', days),
    queryFn: () => getGatewaySeries(projectId!, days),
    enabled: !!projectId,
    ...contract('volatile'),
  });
}

export function useGatewayBreakdown(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewayBreakdown(projectId ?? '', days),
    queryFn: () => getGatewayBreakdown(projectId!, days),
    enabled: !!projectId,
    ...contract('volatile'),
  });
}

export function useGatewaySessions(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewaySessions(projectId ?? '', days),
    queryFn: () => getGatewaySessions(projectId!, days),
    enabled: !!projectId,
    ...contract('volatile'),
  });
}

export function useGatewayErrors(projectId: string | undefined, days = 30) {
  return useQuery({
    queryKey: qk.project.gatewayErrors(projectId ?? '', days),
    queryFn: () => getGatewayErrors(projectId!, days),
    enabled: !!projectId,
    ...contract('volatile'),
  });
}

export function useGatewayLogs(projectId: string | undefined, opts?: { ok?: boolean }) {
  return useQuery({
    queryKey: qk.project.gatewayLogs(projectId ?? '', opts?.ok ?? null),
    queryFn: () => listGatewayLogs(projectId!, { ok: opts?.ok, limit: 100 }),
    enabled: !!projectId,
    refetchInterval: 10_000,
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
    ...contract('volatile'),
  });
}

export function useSetGatewayBudget(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetGatewayBudgetInput) => setGatewayBudget(projectId!, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.project.gatewayBudgets(projectId ?? '') }),
  });
}

export function useDeleteGatewayBudget(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (budgetId: string) => deleteGatewayBudget(projectId!, budgetId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.project.gatewayBudgets(projectId ?? '') }),
  });
}

export function useGatewayKeys(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.project.gatewayKeys(projectId ?? ''),
    queryFn: () => getGatewayKeys(projectId!),
    enabled: !!projectId && enabled,
    ...contract('volatile'),
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

export interface RunGatewayPlaygroundInput {
  prompt: string;
  models: string[];
  system?: string;
  /** Per-model generation-parameter overrides for this run only — see
   *  `runGatewayPlayground`'s doc comment. */
  generationConfig?: Record<string, GatewayModelGenerationConfig>;
}

/** Run one prompt across up to 6 models side by side — no cache, always a fresh run. */
export function useGatewayPlayground(projectId: string | undefined) {
  return useMutation<GatewayPlaygroundResponse, Error, RunGatewayPlaygroundInput>({
    mutationFn: ({ prompt, models, system, generationConfig }) =>
      runGatewayPlayground(projectId!, prompt, models, system, generationConfig),
  });
}
