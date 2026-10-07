import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// A disposable PostgreSQL container starts with `docker run --rm`, but the
// test's cleanup removes it with `docker rm -f`. A forced remove skips
// `--rm`'s volume cleanup, so every run left the container's anonymous data
// volume behind (~65 MB). On 2026-10-07 997 of them filled the Docker VM disk
// (87 GB) and every local Postgres failed with "No space left on device"
// (learnings ledger, same date). `docker rm -f -v` removes the volume too.

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

function forcedRemovesWithoutVolumes(): string[] {
  try {
    return execFileSync(
      'git',
      ['grep', '-nP', "'docker',\\s*'rm',\\s*'-f'(?!,\\s*'-v')", '--', '*.ts', '*.tsx', '*.mjs'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch {
    // `git grep` exits 1 when nothing matches.
    return [];
  }
}

describe('disposable containers', () => {
  it("every forced `docker rm` also removes the container's anonymous volumes", () => {
    expect(forcedRemovesWithoutVolumes()).toEqual([]);
  });
});
