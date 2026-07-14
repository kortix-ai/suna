import type { KortixProject } from '@kortix/sdk';

export interface ProjectRepositoryGroup {
  key: string;
  label: string;
  repoUrl: string | null;
  projects: KortixProject[];
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

export function groupProjectsByRepository(
  projects: readonly KortixProject[],
): ProjectRepositoryGroup[] {
  const groups = new Map<string, ProjectRepositoryGroup>();

  for (const project of projects) {
    const identity = repositoryIdentity(project.repo_url ?? '');
    const key = identity?.key ?? `project:${project.project_id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.projects.push(project);
      continue;
    }
    groups.set(key, {
      key,
      label: identity?.label ?? 'No repository',
      repoUrl: project.repo_url ?? null,
      projects: [project],
    });
  }

  return [...groups.values()];
}
