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
 * A session's agent config is built from every file at the base commit. A new
 * session takes those files from its own checkout, so no repository size stops
 * it. A running session picks up a base-branch change through the project
 * snapshot, which Kortix cloud builds up to 512 MiB compressed
 * (`KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES` in apps/api/src/config.ts).
 * Above that, the session keeps the config it runs until a new session. The
 * check counts raw bytes, so a repository under this total always converges.
 */
const REPO_WARN_BYTES = 512 * 1024 * 1024;
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
  // Directories are asked too: `fixtures export-ignore` marks the folder, and
  // `git archive` (like the API's release) leaves out everything under it.
  const ancestors = (path: string) =>
    path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  const queried = [...new Set(paths.flatMap((path) => [...ancestors(path), path]))];
  const ignored = new Set<string>();
  const lfs = new Set<string>();
  const attrs =
    git(root, ['check-attr', '-z', '--stdin', 'export-ignore', 'filter'], queried.join('\0'))?.split('\0') ?? [];
  for (let i = 0; i + 2 < attrs.length; i += 3) {
    if (attrs[i + 1] === 'export-ignore' && attrs[i + 2] === 'set') ignored.add(attrs[i]!);
    if (attrs[i + 1] === 'filter' && attrs[i + 2] === 'lfs') lfs.add(attrs[i]!);
  }

  let total = 0;
  const files: { path: string; bytes: number }[] = [];
  for (const path of paths) {
    if (ignored.has(path) || ancestors(path).some((dir) => ignored.has(dir))) continue;
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
      ? `the files in Git total ${mib(total)}. A new session still runs the agent config, but above 512 MiB compressed Kortix builds no project snapshot, so a running session stops picking up agent config changes from the base branch until a new session starts.`
      : `large static files are in Git. Every session downloads them, and so does every agent config change a running session picks up.`;
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
