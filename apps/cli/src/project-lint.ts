/**
 * The project checks `kortix validate` runs beyond the manifest schema, and
 * the same list `kortix ship` runs before it commits: the sandbox Dockerfile
 * lint, the agent wiring lint, and the repository size check.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { ManifestIssue } from '@kortix/manifest-schema';
import { extractSandboxTemplates } from '@kortix/shared/sandbox';
import { lintDockerfile } from './dockerfile-lint.ts';
import { lintWiring } from './wiring-lint.ts';

/**
 * A session's agent config is built from every file at the base commit
 * (`git archive`). The API refuses an archive over 32 MiB gzip or 128 MiB tar
 * (`MAX_CONFIG_ARCHIVE_BYTES` / `MAX_CONFIG_TAR_BYTES` in
 * apps/api/src/config-releases/release-tree.ts), and the session then runs the
 * platform default config. The check counts raw bytes, so a repository under
 * this total always builds.
 */
const REPO_WARN_BYTES = 32 * 1024 * 1024;
/** One file this large is a static asset that belongs outside Git. */
const FILE_WARN_BYTES = 10 * 1024 * 1024;
const LISTED_FILES = 5;
const LFS_POINTER_BYTES = 200;

export function lintProject(
  parsed: Record<string, unknown> | null,
  manifestPath: string,
  opts: { dockerfileLint?: boolean } = {},
): ManifestIssue[] {
  const root = dirname(manifestPath);
  return [
    ...(opts.dockerfileLint === false ? [] : lintSandboxDockerfiles(parsed, manifestPath)),
    ...lintWiring(parsed, root),
    ...lintRepoSize(root),
  ];
}

/**
 * Lint each `sandbox.templates[].dockerfile` that exists on disk, resolved
 * relative to the MANIFEST's directory (paths in kortix.yaml are repo-relative,
 * and --file may point outside the cwd).
 *
 * A declared-but-missing Dockerfile is NOT reported here: that's the manifest
 * validator's business, and inventing a second, differently-worded error for it
 * would just double up the report.
 */
function lintSandboxDockerfiles(
  parsed: Record<string, unknown> | null,
  manifestPath: string,
): ManifestIssue[] {
  if (!parsed) return [];
  const root = dirname(manifestPath);
  const issues: ManifestIssue[] = [];
  for (const tpl of extractSandboxTemplates(parsed)) {
    if (!tpl.dockerfile) continue;
    const abs = resolve(root, tpl.dockerfile);
    if (!existsSync(abs)) continue;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // Report the path as written in the manifest when it stays inside the
    // project, so the author sees the string they typed.
    const shown = relative(root, abs).startsWith('..') ? abs : tpl.dockerfile;
    issues.push(...lintDockerfile(text, { path: shown }));
  }
  return issues;
}

function git(cwd: string, args: string[], input?: string): string | null {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * Warn when the files Git stores are large: tracked files plus the untracked,
 * not-ignored ones `kortix ship` (`git add -A`) commits next, minus the paths
 * `.gitattributes` marks `export-ignore` (`git archive` leaves them out of the
 * release). A Git LFS file counts as its pointer. A warning, never an error: the push still works, only the agent
 * config build and every session clone pay for it. Not a Git repository → no
 * check.
 */
export function lintRepoSize(dir: string): ManifestIssue[] {
  const root = git(dir, ['rev-parse', '--show-toplevel'])?.trim();
  if (!root) return [];
  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (!listed) return [];
  const paths = [...new Set(listed.split('\0').filter(Boolean))];

  // `check-attr -z` prints `<path>\0<attribute>\0<value>\0` per path and attribute.
  const ignored = new Set<string>();
  const lfs = new Set<string>();
  const attrs =
    git(root, ['check-attr', '-z', '--stdin', 'export-ignore', 'filter'], paths.join('\0'))?.split('\0') ?? [];
  for (let i = 0; i + 2 < attrs.length; i += 3) {
    if (attrs[i + 1] === 'export-ignore' && attrs[i + 2] === 'set') ignored.add(attrs[i]!);
    if (attrs[i + 1] === 'filter' && attrs[i + 2] === 'lfs') lfs.add(attrs[i]!);
  }

  let total = 0;
  const files: { path: string; bytes: number }[] = [];
  for (const path of paths) {
    if (ignored.has(path)) continue;
    let bytes: number;
    try {
      const stat = lstatSync(join(root, path));
      // A directory is a submodule: `git archive` does not include its files.
      if (stat.isDirectory()) continue;
      // Git LFS stores a pointer of ~130 bytes; that is what `git archive` ships.
      bytes = lfs.has(path) ? Math.min(stat.size, LFS_POINTER_BYTES) : stat.size;
    } catch {
      continue; // tracked but deleted in the working tree
    }
    total += bytes;
    files.push({ path, bytes });
  }

  const large = files.filter((f) => f.bytes >= FILE_WARN_BYTES);
  if (total <= REPO_WARN_BYTES && large.length === 0) return [];

  const shown = (large.length > 0 ? large : files)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, LISTED_FILES)
    .map((f) => `${f.path} (${mib(f.bytes)})`);
  const headline =
    total > REPO_WARN_BYTES
      ? `the files in Git total ${mib(total)}. A session builds its agent config from the whole repository, and that build fails above 32 MiB compressed: the session then runs the platform default config.`
      : `large static files are in Git. Every session clones them, and they count toward the 32 MiB limit on the agent config a session builds from the repository.`;
  return [
    {
      path: 'repository',
      severity: 'warning',
      message: [
        headline,
        `Largest: ${shown.join(', ')}.`,
        'Keep big static assets out of Git: put them in object storage (S3, R2, GCS) or a CDN and download them at runtime.',
        'A path that must stay in Git but that no agent reads can be left out of the agent config with `<path> export-ignore` in .gitattributes.',
      ].join('\n    '),
    },
  ];
}
