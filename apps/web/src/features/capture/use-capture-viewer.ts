'use client';

import { getProjectDetail, listProjectAccess } from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * Who is looking at the Capture area, and with which rights. The API decides
 * scope the same way (`apps/api/src/capture/project-routes.ts` `captureAccess`):
 * a project manager (effective role `manager`) may read another member and the
 * whole project; everyone else reads only their own data.
 */
export function useCaptureViewer(projectId: string) {
  const flag = useFeatureFlag(projectId, 'capture');
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;
  return {
    enabled: flag.enabled,
    // A cached "off" (hydrated or stale) is not an answer while a refetch runs:
    // turning the flag on elsewhere must not 404 the area until the fresh read lands.
    isLoading: flag.isLoading || detail.isLoading || (!flag.enabled && detail.isFetching),
    isManager: project?.effective_project_role === 'manager',
    projectName: project?.name ?? '',
  };
}

/** The project's members with their emails, for a manager's person picker and the People page. */
export function useCaptureMembers(projectId: string, enabled: boolean) {
  const access = useQuery({
    queryKey: qk.project.access(projectId),
    queryFn: () => listProjectAccess(projectId),
    enabled: enabled && !!projectId,
    ...contract('inventory'),
  });
  const members = useMemo(
    () => (access.data?.members ?? []).filter((member) => member.effective_project_role !== null),
    [access.data],
  );
  return { members, viewerId: access.data?.viewer_user_id ?? null, isLoading: access.isLoading };
}

/**
 * The Capture area's URL state: `user` (a member, managers only), `device`,
 * `day` (local `YYYY-MM-DD`), `at` (an ISO instant), `q` (a search). Every
 * view is a link: People opens `?user=`, an Ask answer cites `?at=`.
 */
export function useCaptureParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const get = (key: string) => params.get(key) || null;
  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return {
    user: get('user'),
    device: get('device'),
    day: get('day'),
    at: get('at'),
    q: get('q'),
    set,
  };
}
