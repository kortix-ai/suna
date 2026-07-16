'use client';

import { getProjectDetail } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';

/**
 * The single on/off switch for the unified model picker (`unified_model_picker`),
 * read from the server's per-project experimental flags — mirrors
 * `useReviewCenterEnabled`. Gates `ComposerChatInput`'s choice between the one
 * `ModelPicker` and the legacy `ModelSelector`/`HarnessModelSelector` fork.
 * Reads the shared `['project-detail', projectId]` cache entry, so it adds no
 * extra fetch alongside the detail query the sidebar already runs.
 */
export function useUnifiedModelPickerEnabled(projectId: string): boolean {
  const { data } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return data?.project?.experimental?.unified_model_picker ?? false;
}
