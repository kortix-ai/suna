import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The CLI command tables in apps/web/content/docs/developers.mdx (the
// generated:cli-commands region) are generated from apps/cli/src/command-table.ts.
// A command added, removed, renamed or flagged there without a regenerate leaves
// the public reference stale. Fix: bun apps/web/scripts/generate-cli-commands-doc.mjs

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('CLI commands doc', () => {
  it('matches the CLI command table', () => {
    expect(() =>
      execFileSync('bun', ['apps/web/scripts/generate-cli-commands-doc.mjs', '--check'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
