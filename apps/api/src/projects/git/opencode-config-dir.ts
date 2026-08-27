import { manifestCandidatePaths, parseManifestText } from '@kortix/manifest-schema';
import { runGitCapture } from './mirror';
import type { GitBackedProject } from './types';

/** Where OpenCode reads project config when the manifest does not override it. */
export const DEFAULT_OPENCODE_CONFIG_DIR = '.kortix/opencode';

/** A literal relative directory path and nothing cleverer — same guard as the daemon's manifest reader. */
export function safeOpencodeConfigDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('-')) return null;
  if (
    trimmed
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || !/^[\w .-]+$/.test(part))
  ) {
    return null;
  }
  return trimmed;
}

/**
 * Resolve the OpenCode config dir the daemon WILL pick for `sourceSha`, from
 * the API's bare mirror — the manifest's `opencode.config_dir` when set, else
 * the default — and only when that dir ships an `opencode.json[c]`. `null`
 * means the revision carries no project OpenCode config, so the daemon runs
 * on its baked default dir. Mirrors `resolveOpencodeConfigDir` in
 * apps/kortix-sandbox-agent-server/src/config.ts, evaluated server-side.
 */
export async function resolveOpencodeConfigDirAtSha(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  sourceSha: string,
): Promise<string | null> {
  let configDir = DEFAULT_OPENCODE_CONFIG_DIR;
  for (const candidate of manifestCandidatePaths(project.manifestPath)) {
    const manifest = await runGitCapture(['show', `${sourceSha}:${candidate.path}`], mirror);
    if (manifest.exitCode !== 0) continue;
    const parsed = parseManifestText(manifest.stdout, candidate.format);
    const opencode = parsed.opencode;
    if (opencode && typeof opencode === 'object' && !Array.isArray(opencode)) {
      configDir =
        safeOpencodeConfigDir((opencode as Record<string, unknown>).config_dir) ?? configDir;
    }
    break;
  }
  for (const filename of ['opencode.jsonc', 'opencode.json']) {
    const exists = await runGitCapture(
      ['cat-file', '-e', `${sourceSha}:${configDir}/${filename}`],
      mirror,
    );
    if (exists.exitCode === 0) return configDir;
  }
  return null;
}
