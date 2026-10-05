'use client';

import { getProjectDetail, listProjectAccess } from '@kortix/sdk';
import { contract, qk, useCaptureWorkspace } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * The Capture tenant of this page: the account that owns the project. Capture
 * has no project in its model; the area lives under a project route only until
 * it moves to an account route, so the page resolves the project's account and
 * every Capture call takes that.
 */
export function useCaptureAccountId(projectId: string): string | null {
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  return detail.data?.project?.account_id ?? null;
}

/**
 * Who is looking at the Capture area, and with which rights. The API decides
 * scope the same way (`apps/api/src/capture/account-routes.ts`
 * `captureAccessFor`): a Capture `admin` or `viewer` may read another member
 * and the whole account; a `member` reads only their own data. Capture is on
 * or off for the whole account.
 */
export function useCaptureViewer(projectId: string) {
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = detail.data?.project;
  const workspace = useCaptureWorkspace(project?.account_id ?? null);
  const role = workspace.data?.role ?? null;
  return {
    accountId: project?.account_id ?? null,
    enabled: workspace.data?.enabled ?? false,
    isLoading: detail.isLoading || workspace.isLoading,
    /** Reads other members and the account (Capture admin or viewer). */
    isManager: role === 'admin' || role === 'viewer',
    /** Writes the policy (Capture admin). */
    isAdmin: role === 'admin',
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
