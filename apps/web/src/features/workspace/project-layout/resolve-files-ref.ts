/**
 * Resolve the git ref the standalone Files view reads from.
 *
 * Split out of `ProjectFilesView` because `ready` is the whole point of Fix C:
 * `useFileList` gates on `enabled: !!projectId && !!ref && !!dirPath &&
 * options?.enabled !== false` (src/features/project-files/hooks/use-file-list.ts:31),
 * so the directory listing cannot start until a ref exists. A persisted version
 * selection alone is enough to produce one — the project fetch is needed only
 * for the default-branch fallback — so the view must not block the listing on
 * `getProject` when a selection is already known.
 */

export interface ResolveFilesRefInput {
  /** Persisted per-project Version selection, from `useSelectedVersion`. */
  selectedVersion: string | undefined;
  /** Canonical project meta, once the `['project', id]` cache slot has it. */
  project: { default_branch: string } | undefined;
}

export interface ResolvedFilesRef {
  /** The ref to read files from. Empty string means "not resolvable yet". */
  ref: string;
  /** The project's default branch, or '' while unknown. Change-request and
   *  version UI compare against it to tell "on main" from "on a version". */
  defaultBranch: string;
  /** True once `ref` is usable, i.e. safe to mount `ProjectFilesProvider`. */
  ready: boolean;
}

export function resolveFilesRef({
  selectedVersion,
  project,
}: ResolveFilesRefInput): ResolvedFilesRef {
  const defaultBranch = project?.default_branch ?? '';
  // `||` not `??`: an empty-string ref is not a usable ref, and treating one as
  // present would leave useFileList disabled forever.
  const ref = selectedVersion || defaultBranch;

  return { ref, defaultBranch, ready: ref !== '' };
}
