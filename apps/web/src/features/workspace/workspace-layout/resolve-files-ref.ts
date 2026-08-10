/**
 * Resolve the git ref the standalone Files view reads from.
 *
 * Split out of `WorkspaceFilesView` because `ready` is the whole point of Fix C:
 * `useFileList` gates on `enabled: !!workspaceId && !!ref && !!dirPath &&
 * options?.enabled !== false` (src/features/workspace-files/hooks/use-file-list.ts:31),
 * so the directory listing cannot start until a ref exists. A persisted version
 * selection alone is enough to produce one — the workspace fetch is needed only
 * for the default-branch fallback — so the view must not block the listing on
 * `getWorkspace` when a selection is already known.
 */

export interface ResolveFilesRefInput {
  /** Persisted per-workspace Version selection, from `useSelectedVersion`. */
  selectedVersion: string | undefined;
  /** Canonical workspace meta, once the `qk.workspace.summary(id)` cache slot has it. */
  workspace: { default_branch: string } | undefined;
}

export interface ResolvedFilesRef {
  /** The ref to read files from. Empty string means "not resolvable yet". */
  ref: string;
  /** The workspace's default branch, or '' while unknown. Change-request and
   *  version UI compare against it to tell "on main" from "on a version". */
  defaultBranch: string;
  /** True once `ref` is usable, i.e. safe to mount `WorkspaceFilesProvider`. */
  ready: boolean;
}

export function resolveFilesRef({
  selectedVersion,
  workspace,
}: ResolveFilesRefInput): ResolvedFilesRef {
  const defaultBranch = workspace?.default_branch ?? '';
  // `||` not `??`: an empty-string ref is not a usable ref, and treating one as
  // present would leave useFileList disabled forever.
  const ref = selectedVersion || defaultBranch;

  return { ref, defaultBranch, ready: ref !== '' };
}
