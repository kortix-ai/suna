import type { ProjectBranch } from '@kortix/sdk';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session branch is named by its session id. A person knows it by the session's title (KRTX-3020). */
export function versionLabel(ref: string, branches: readonly ProjectBranch[] | undefined): string {
  const title = branches?.find((b) => b.name === ref)?.session?.title?.trim();
  return title || (UUID_RE.test(ref) ? ref.slice(0, 8) : ref);
}

/** The default branch first, live work newest first, then archived or deleted work. */
export function orderVersions(branches: readonly ProjectBranch[], defaultBranch: string): ProjectBranch[] {
  const rank = (b: ProjectBranch) =>
    b.name === defaultBranch ? 0 : b.session?.archived || b.session?.deleted ? 2 : 1;
  return [...branches].sort(
    (a, b) => rank(a) - rank(b) || (b.committed_at ?? '').localeCompare(a.committed_at ?? ''),
  );
}
