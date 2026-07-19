import { closeSync, constants, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Append missing repository-local excludes through one stable file descriptor. */
export function appendGitExcludeEntries(
  repoRoot: string,
  entries: readonly string[],
  comment: string,
): void {
  const gitPath = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (gitPath.status !== 0) return;
  const rawPath = gitPath.stdout.trim();
  if (!rawPath) return;

  const excludePath = resolve(repoRoot, rawPath);
  const descriptor = openSync(
    excludePath,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND,
    0o600,
  );
  try {
    const existing = readFileSync(descriptor, 'utf8');
    const existingEntries = new Set(existing.split(/\r?\n/));
    const missing = entries.filter((entry) => !existingEntries.has(entry));
    if (missing.length === 0) return;
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    writeSync(descriptor, `${prefix}# ${comment}\n${missing.join('\n')}\n`, null, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}
