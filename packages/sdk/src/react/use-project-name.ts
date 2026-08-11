'use client';

import { useQuery } from '@tanstack/react-query';
import { getWorkspaceDetail } from '../core/rest/workspaces-client';
import { qk } from './query-keys';
import { contract } from './query-contracts';

/**
 * The ONLY way to read a project's name.
 *
 * The two-titles bug was not an invalidation gap, it was two sources for one
 * fact: `project-switcher.tsx` read `activeProject?.name` off the projects
 * LIST and fell back to the detail, while `project-home.tsx` read the detail
 * alone. Any divergence between the two caches rendered as two different names
 * on one screen.
 *
 * One accessor makes that structurally impossible rather than merely currently
 * invalidated. Do not reintroduce a `??` fallback to another source here.
 */
export function useWorkspaceName(workspaceId: string | undefined): string | undefined {
  const { data } = useQuery({
    queryKey: qk.workspace.detail(workspaceId ?? ''),
    queryFn: () => getWorkspaceDetail(workspaceId as string),
    enabled: Boolean(workspaceId),
    ...contract('config'),
  });
  return data?.workspace?.name;
}

/**
 * The owning account id, read off the SAME `qk.workspace.detail(id)` entry
 * `useProjectName` reads — every capability surface already mounts that
 * observer, so this shares the cache instead of adding a fetch. Previously
 * lived in `apps/web`'s `project-detail-query.ts` as a host-local hook; moved
 * here because `qk.workspace.detail` + `contract('config')` is SDK-owned
 * wiring, not something a host should hand-roll a second time.
 */
export function useWorkspaceAccountId(workspaceId: string | undefined): string | undefined {
  const { data } = useQuery({
    queryKey: qk.workspace.detail(workspaceId ?? ''),
    queryFn: () => getWorkspaceDetail(workspaceId as string),
    enabled: Boolean(workspaceId),
    ...contract('config'),
  });
  return data?.workspace?.account_id;
}

/** @deprecated Use `useWorkspaceName`. */
export const useProjectName = useWorkspaceName;
/** @deprecated Use `useWorkspaceAccountId`. */
export const useProjectAccountId = useWorkspaceAccountId;
