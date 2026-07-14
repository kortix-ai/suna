'use client';

/**
 * Shared "is the LLM gateway on for this project" signal — previously fetched
 * and derived independently in `model-selector.tsx` and
 * `use-model-connection-gate.tsx` (same `project-detail` query, same
 * `isLlmGatewayEnabled` call, copy-pasted). One hook now; the raw query is
 * exposed too so a caller that also needs other project fields (e.g.
 * `account_id` for an upgrade dialog) doesn't need a second `useQuery` for
 * the same key.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { getProjectDetail, type ProjectDetail } from '@kortix/sdk/projects-client';

export interface ProjectLlmGatewayState {
  llmGatewayEnabled: boolean;
  query: UseQueryResult<ProjectDetail>;
}

export function useProjectLlmGatewayEnabled(
  projectId: string | null | undefined,
): ProjectLlmGatewayState {
  const query = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  return {
    llmGatewayEnabled: isLlmGatewayEnabled(query.data?.project),
    query,
  };
}
