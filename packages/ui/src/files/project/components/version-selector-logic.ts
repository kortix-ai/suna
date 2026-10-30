import type { ProjectBranch } from '@kortix/sdk';

/** A session branch is named by its session id. A person knows it by the session's title (KRTX-3020). */
export function versionTitle(branch: ProjectBranch): string {
  return branch.session?.title?.trim() || branch.name;
}

/** Search reads the title, the agent, the branch name and the last commit. */
export function versionMatches(branch: ProjectBranch, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [branch.session?.title, branch.session?.agent_name, branch.name, branch.subject].some((value) =>
    value?.toLowerCase().includes(q),
  );
}

/** The default branch, live work, then what the person archived or deleted, each in served order. */
export function groupVersions(branches: ProjectBranch[]): {
  primary: ProjectBranch[];
  others: ProjectBranch[];
  archived: ProjectBranch[];
} {
  const primary: ProjectBranch[] = [];
  const others: ProjectBranch[] = [];
  const archived: ProjectBranch[] = [];
  for (const b of branches) {
    if (b.is_default) primary.push(b);
    else if (b.session?.archived || b.session?.deleted) archived.push(b);
    else others.push(b);
  }
  return { primary, others, archived };
}
