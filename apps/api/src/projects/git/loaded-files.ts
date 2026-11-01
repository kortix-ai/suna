import { posix } from 'node:path';
import { manifestCandidatePaths, parseManifestText } from '@kortix/manifest-schema';
import { runGitCapture } from './mirror';
import type { GitBackedProject } from './types';

/** The parsed manifest at `sha` in the API's bare mirror, or null when the commit has none. */
export async function readManifestAtSha(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  sha: string,
): Promise<Record<string, unknown> | null> {
  for (const path of manifestCandidatePaths(project.manifestPath)) {
    const manifest = await runGitCapture(['show', `${sha}:${path}`], mirror);
    if (manifest.exitCode !== 0) continue;
    try {
      return parseManifestText(manifest.stdout);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Did the files a session loads from the repository change between the commit
 * a box holds and `tipSha`?
 *
 * The compiled agent-config etag answers "did an agent, a prompt or a command
 * change". It cannot see a skill body, a tool, or an extension module — none of
 * them enter the compiled config — so a merge that touched only those left every
 * running session reporting `stale: false`, and the header never offered the
 * reload. This is the other half: the registered skill folders and the tool
 * and extension module folders (`loadedPaths`).
 *
 * Tri-state, like `isConfigStale`: `null` when it cannot be told. That is a
 * commit the mirror has never seen — a session that committed without pushing
 * reports a HEAD only it holds — and it must never read as "up to date".
 */
export async function loadedFilesChangedBetween(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  boxSha: string,
  tipSha: string,
): Promise<boolean | null> {
  if (!/^[0-9a-f]{40}$/i.test(boxSha) || !/^[0-9a-f]{40}$/i.test(tipSha)) return null;
  if (boxSha === tipSha) return false;
  for (const sha of [boxSha, tipSha]) {
    const known = await runGitCapture(['cat-file', '-e', `${sha}^{commit}`], mirror);
    if (known.exitCode !== 0) return null;
  }
  const manifest = await readManifestAtSha(mirror, project, tipSha);
  const paths = manifest ? loadedPaths(manifest) : [];
  if (paths.length === 0) return false;
  // `GIT_LITERAL_PATHSPECS`: the paths come from a repo-controlled manifest.
  const diff = await runGitCapture(
    ['diff', '--quiet', boxSha, tipSha, '--', ...paths],
    mirror,
    null,
    { GIT_LITERAL_PATHSPECS: '1' },
  );
  if (diff.exitCode === 0) return false;
  if (diff.exitCode === 1) return true;
  return null;
}

/**
 * What a session loads from the repository that the compiled config does not
 * carry: each registered skill folder, and the folder of each tool and
 * extension module (a module imports its siblings). Prompts and commands are
 * compiled in, so the etag already sees them.
 */
function loadedPaths(manifest: Record<string, unknown>): string[] {
  const map = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const repoPath = (value: unknown) => (typeof value === 'string' && !value.startsWith('npm:') ? value : null);
  const paths = new Set<string>();
  for (const folder of Object.values(map(manifest.skills))) if (repoPath(folder)) paths.add(folder as string);
  for (const module of Object.values(map(manifest.tools))) if (repoPath(module)) paths.add(posix.dirname(module as string));
  for (const extension of Object.values(map(manifest.extensions))) {
    const { opencode, pi } = map(extension);
    if (repoPath(opencode)) paths.add(posix.dirname(opencode as string));
    const piSource = repoPath(typeof pi === 'string' ? pi : map(pi).source);
    if (piSource) paths.add(piSource);
  }
  return [...paths].filter((path) => path && path !== '.');
}
