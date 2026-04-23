'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';

export type WorkspaceKind = 'personal' | 'project' | 'legacy';


export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  label: string;
  path: string;
  project_id?: string;
}

export function useWorkspaces() {
  const baseUrl = getActiveOpenCodeUrl();
  return useQuery<Workspace[]>({
    queryKey: ['kortix', 'file-workspaces', baseUrl],
    queryFn: async () => {
      const res = await authenticatedFetch(`${baseUrl}/file/workspaces`);
      if (!res.ok) throw new Error(`workspaces fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}

export function findWorkspaceForPath(
  workspaces: Workspace[] | undefined,
  currentPath: string,
): Workspace | null {
  if (!workspaces || workspaces.length === 0) return null;
  const normalized = currentPath.replace(/\/+$/, '') || '/';
  return (
    workspaces.find((w) => {
      const root = w.path.replace(/\/+$/, '');
      return normalized === root || normalized.startsWith(`${root}/`);
    }) ?? null
  );
}

export function friendlyBreadcrumbs(
  workspaces: Workspace[] | undefined,
  currentPath: string,
): Array<{ label: string; path: string; isRoot?: boolean }> {
  const workspace = findWorkspaceForPath(workspaces, currentPath);
  if (!workspace) {
    return currentPath
      .split('/')
      .filter(Boolean)
      .map((segment, idx, arr) => ({
        label: segment,
        path: '/' + arr.slice(0, idx + 1).join('/'),
      }));
  }
  const root = workspace.path.replace(/\/+$/, '');
  const rest = currentPath.slice(root.length).split('/').filter(Boolean);
  const crumbs: Array<{ label: string; path: string; isRoot?: boolean }> = [
    { label: workspace.label, path: root, isRoot: true },
  ];
  let acc = root;
  for (const seg of rest) {
    acc = `${acc}/${seg}`;
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs;
}

export function useDefaultWorkspace(): Workspace | null {
  const { data } = useWorkspaces();
  return useMemo(() => {
    if (!data || data.length === 0) return null;
    const personal = data.find((w) => w.kind === 'personal');
    return personal ?? data[0] ?? null;
  }, [data]);
}
