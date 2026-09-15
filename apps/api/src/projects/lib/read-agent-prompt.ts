import { validAgentResourceSource } from '@kortix/manifest-schema';
import type { GitBackedProject } from '../git/types';
import { refreshMirror, runGit } from '../git/mirror';
import { validateRef } from '../git-ref';

export async function readAgentPrompt(
  project: GitBackedProject,
  path: string,
  ref: string,
): Promise<string> {
  if (!validAgentResourceSource(path))
    throw new Error(
      'Agent prompt must use a repository-relative file path without secrets or traversal',
    );
  const mirror = await refreshMirror(project);
  const tree = await runGit(['ls-tree', '-z', '-l', validateRef(ref), '--', path], mirror, false);
  const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t([^\0]+)\0$/.exec(tree.stdout);
  if (!match || match[4] !== path)
    throw new Error(`Agent prompt "${path}" must be an existing regular Git file`);
  if (Number(match[3]) > 8 * 1024 * 1024) throw new Error(`Agent prompt "${path}" exceeds 8 MiB`);
  return (await runGit(['cat-file', 'blob', match[2]!], mirror, false)).stdout;
}
