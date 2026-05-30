/**
 * Validation for git refs / SHAs that are passed as positional arguments to
 * git subcommands.
 *
 * The leading-`-` check is security-critical: a ref is often passed as a bare
 * positional arg (e.g. `git grep ... <ref>`, `git archive ... <ref>`,
 * `git ls-tree <ref>`). Without it, a client-supplied ref like
 * `--open-files-in-pager=<cmd>` (git grep) or `--output=<path>` (git archive)
 * would be parsed by git as an OPTION rather than a ref — i.e. argument /
 * option injection. Restricting to a conservative charset and rejecting a
 * leading `-` neutralizes that while still allowing branch names, tags, HEAD
 * and SHAs.
 */
export function validateRef(ref: string): string {
  if (!ref) throw new Error('Ref is required');
  // git refs forbid: spaces, "..", "@{", "\\", control chars. Be conservative.
  if (!/^[A-Za-z0-9._\-\/]+$/.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw new Error('Invalid ref');
  }
  return ref;
}

export function validateSha(sha: string): string {
  if (!sha || !/^[0-9a-fA-F]{4,64}$/.test(sha)) throw new Error('Invalid commit hash');
  return sha;
}
