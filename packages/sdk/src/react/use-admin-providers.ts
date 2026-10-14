import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAdminProviderDistribution, listAdminSandboxes, getAdminProviderAnalytics, getAdminProviderFallback, setAdminProviderDistribution, migrateAdminSandboxProvider, setAdminProviderFallback } from '../core/rest/projects-client/admin-providers';
export function useAdminProviderDistribution() {
  return useQuery({ queryKey: ['admin', 'provider-distribution'], queryFn: () => getAdminProviderDistribution() });
}
export function useAdminProviderSandboxes() {
  return useQuery({ queryKey: ['admin', 'sandboxes'], queryFn: () => listAdminSandboxes(300), refetchInterval: 10_000 });
}
export function useAdminProviderAnalytics(days: number, enabled: boolean) {
  return useQuery({ queryKey: ['admin', 'provider-analytics', days], queryFn: () => getAdminProviderAnalytics(days), enabled, refetchInterval: enabled ? 30_000 : false });
}
export function useAdminProviderFallback() {
  return useQuery({ queryKey: ['admin', 'provider-fallback'], queryFn: () => getAdminProviderFallback() });
}
export interface AdminProviderMutationOptions { onSuccess?: () => void; onError?: (error: Error) => void; }
export interface AdminProviderMigrationVariables { sessionId: string; targetProvider: string; }
export function useSetAdminProviderDistribution(options: AdminProviderMutationOptions = {}) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (weights: Record<string, number>) => setAdminProviderDistribution(weights), onError: options.onError, onSuccess: () => {
    options.onSuccess?.();
    void qc.invalidateQueries({ queryKey: ['admin', 'provider-distribution'] });
  } });
}
export function useMigrateAdminSandboxProvider(options: AdminProviderMutationOptions = {}) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ sessionId, targetProvider }: AdminProviderMigrationVariables) => migrateAdminSandboxProvider(sessionId, targetProvider), onError: options.onError, onSuccess: () => {
    options.onSuccess?.();
    void qc.invalidateQueries({ queryKey: ['admin', 'sandboxes'] });
  } });
}
export function useSetAdminProviderFallback(options: AdminProviderMutationOptions = {}) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (enabled: boolean) => setAdminProviderFallback(enabled), onError: options.onError, onSuccess: () => {
    options.onSuccess?.();
    void qc.invalidateQueries({ queryKey: ['admin', 'provider-fallback'] });
  } });
}
