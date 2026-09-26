/**
 * The project detail read the Agents and Skills tabs share.
 *
 * `useProjectConfig` from `@kortix/sdk/react` returns the config and nothing
 * else — no `isLoading`, no `isError` — so a 403 (it is fetched with
 * `retry: false`) is indistinguishable from a request still in flight, and a
 * tab built on it spins forever for a member who may not read the config.
 * This asks the same question through the same client and the SAME cache key
 * (`qk.project.detail`), so the two hooks share one entry and one request,
 * and the tab gets the query state it needs to render an error.
 */

import type { ProjectConfigSummary, ProjectDetail } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { kortix } from '../../kortix.ts';

export interface ProjectDetailState {
  config: ProjectConfigSummary | undefined;
  loading: boolean;
  errorMessage: string | null;
  refetch: () => void;
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

export function useProjectDetailState(projectId: string | null): ProjectDetailState {
  const query = useQuery<ProjectDetail>({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () =>
      kortix()
        .project(projectId as string)
        .detail(),
    enabled: Boolean(projectId),
    retry: false,
  });
  return {
    config: query.data?.config,
    loading: query.isLoading,
    errorMessage: query.isError ? errorText(query.error) : null,
    refetch: () => void query.refetch(),
  };
}
