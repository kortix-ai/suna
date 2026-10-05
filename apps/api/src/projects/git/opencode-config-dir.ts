import {
  AGENTS_DIR,
  manifestCandidatePaths,
  opencodeConfigDirCandidates,
  parseManifestText,
  SKILLS_DIR,
} from '@kortix/manifest-schema';
import { runGitCapture } from './mirror';
import type { GitBackedProject } from './types';

/** The parsed manifest at `sha` in the API's bare mirror, or null when the commit has none. */
export async function readManifestAtSha(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  sha: string,
): Promise<Record<string, unknown> | null> {
  for (const candidate of manifestCandidatePaths(project.manifestPath)) {
    const manifest = await runGitCapture(['show', `${sha}:${candidate.path}`], mirror);
    if (manifest.exitCode !== 0) continue;
    try {
      return parseManifestText(manifest.stdout, candidate.format);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve the OpenCode config dir the daemon WILL pick for `sourceSha`, from
 * the API's bare mirror: the first of `opencodeConfigDirCandidates` (the
 * manifest's `opencode.config_dir`, else `harnesses/opencode`, then the legacy
 * `.kortix/opencode`) that ships an `opencode.json[c]`. `null` means the
 * revision carries no project OpenCode config, so the daemon runs on its baked
 * default dir. Mirrors `resolveOpencodeConfigDir` in the daemon's
 * harness/open-code/config.ts, evaluated server-side.
 */
export async function resolveOpencodeConfigDirAtSha(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  sourceSha: string,
  manifest?: Record<string, unknown> | null,
): Promise<string | null> {
  const parsed = manifest === undefined ? await readManifestAtSha(mirror, project, sourceSha) : manifest;
  for (const configDir of opencodeConfigDirCandidates(parsed)) {
    for (const filename of ['opencode.jsonc', 'opencode.json']) {
      const exists = await runGitCapture(
        ['cat-file', '-e', `${sourceSha}:${configDir}/${filename}`],
        mirror,
      );
      if (exists.exitCode === 0) return configDir;
    }
  }
  return null;
}

/**
 * Did the harness config change between the commit a box holds and `tipSha`?
 *
 * The compiled agent-config etag answers "did governance or an agent's
 * frontmatter change". It cannot see a skill body, a tool, or a plugin — none of
 * them enter the compiled config — so a merge that touched only those left every
 * running session reporting `stale: false`, and the header never offered the
 * reload. This is the other half: the OpenCode config dir plus the root
 * `skills/` and `agents/` a session loads beside it.
 *
 * Tri-state, like `isConfigStale`: `null` when it cannot be told. That is a
 * commit the mirror has never seen — a session that committed without pushing
 * reports a HEAD only it holds — and it must never read as "up to date".
 */
export async function opencodeConfigDirChangedBetween(
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
  const configDir = await resolveOpencodeConfigDirAtSha(mirror, project, tipSha);
  // The tip ships no project config: there is nothing a reload could bring in.
  if (!configDir) return false;
  // `GIT_LITERAL_PATHSPECS`: the config dir comes from a repo-controlled manifest.
  const diff = await runGitCapture(
    ['diff', '--quiet', boxSha, tipSha, '--', configDir, SKILLS_DIR, AGENTS_DIR],
    mirror,
    null,
    { GIT_LITERAL_PATHSPECS: '1' },
  );
  if (diff.exitCode === 0) return false;
  if (diff.exitCode === 1) return true;
  return null;
}
