'use client';

import { useQuery } from '@tanstack/react-query';

import {
  getViewerSandboxScopes,
  type SandboxViewerScopes,
} from '@/lib/platform-client';

export function useViewerScopes(sandboxId: string | null | undefined) {
  return useQuery<SandboxViewerScopes>({
    queryKey: ['sandbox', 'viewer-scopes', sandboxId],
    queryFn: () => getViewerSandboxScopes(sandboxId!),
    enabled: !!sandboxId,
    staleTime: 30_000,
  });
}

export function useCan(sandboxId: string | null | undefined, scope: string) {
  const { data, isLoading } = useViewerScopes(sandboxId);
  return {
    allowed: data ? data.scopes.includes(scope) : false,
    loading: isLoading,
    role: data?.role ?? null,
  };
}
