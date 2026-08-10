import type { KortixWorkspace } from '@kortix/sdk';

export interface WorkspaceRepositoryGroup {
  key: string;
  label: string;
  repoUrl: string | null;
  workspaces: KortixWorkspace[];
}

function repositoryIdentity(repoUrl: string): { key: string; label: string } | null {
  const raw = repoUrl.trim();
  if (!raw) return null;
  const ssh = raw.match(/^git@([^:]+):(.+)$/i);
  const parseable = ssh ? `https://${ssh[1]}/${ssh[2]}` : raw;

  try {
    const url = new URL(parseable);
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (!url.hostname || !path) return null;
    const key = `${url.hostname.toLowerCase()}/${path.toLowerCase()}`;
    return {
      key,
      label: url.hostname.toLowerCase() === 'github.com' ? path : `${url.hostname}/${path}`,
    };
  } catch {
    const key = raw
      .replace(/\.git$/i, '')
      .replace(/\/+$/g, '')
      .toLowerCase();
    return key ? { key, label: key } : null;
  }
}

export function groupWorkspacesByRepository(
  workspaces: readonly KortixWorkspace[],
): WorkspaceRepositoryGroup[] {
  const groups = new Map<string, WorkspaceRepositoryGroup>();

  for (const workspace of workspaces) {
    const identity = repositoryIdentity(workspace.repo_url ?? '');
    const key = identity?.key ?? `workspace:${workspace.workspace_id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.workspaces.push(workspace);
      continue;
    }
    groups.set(key, {
      key,
      label: identity?.label ?? 'No repository',
      repoUrl: workspace.repo_url ?? null,
      workspaces: [workspace],
    });
  }

  return [...groups.values()];
}
