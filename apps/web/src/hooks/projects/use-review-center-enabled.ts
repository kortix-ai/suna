'use client';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * The single on/off switch for the Review Center surface, read from the server's
 * per-project experimental flags (`review_center`). Every review-related surface —
 * the sidebar "Review" pill, the per-session row indicators, and the Customize
 * rail — gates off this one hook so they light up (and go dark) together. Reads
 * the shared `qk.project.detail(id)` cache entry, so it adds no extra
 * fetch alongside the detail query the sidebar already runs.
 */
export function useReviewCenterEnabled(projectId: string): boolean {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  return data?.project?.experimental?.review_center ?? false;
}
