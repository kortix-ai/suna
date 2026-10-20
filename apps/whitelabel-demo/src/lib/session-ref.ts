'use client';

import { kortix } from '@/lib/kortix';
import { useQuery } from '@tanstack/react-query';

/**
 * The git ref that holds a thread's files: the session's own branch (Kortix
 * names it after the session id) once the agent has pushed to it, else the
 * workspace's default branch. Undefined while the branch list loads.
 */
export function useSessionRef(projectId: string, sessionId: string): string | undefined {
  const branches = useQuery({
    queryKey: ['project-branches', projectId],
    queryFn: () => kortix.project(projectId).git.branches(),
  });
  const data = branches.data;
  if (!data) return branches.isError ? 'HEAD' : undefined;
  return data.branches.some((b) => b.name === sessionId) ? sessionId : data.default_branch;
}

// The workspace configuration Kortix scaffolds and the operator's template
// fills: agents, skills, harnesses, memory, the manifest and its README.
// A customer sees the files the agent made, not the platform's layout.
const CONFIG_DIRS = ['agents/', 'skills/', 'harnesses/', 'memory/', '.kortix/'];
const CONFIG_FILES = new Set(['kortix.yaml', 'README.md', '.gitignore']);

/** True for a file the customer made or the agent wrote; false for workspace configuration. */
export function isCustomerFile(path: string): boolean {
  return !CONFIG_FILES.has(path) && !CONFIG_DIRS.some((dir) => path.startsWith(dir));
}
