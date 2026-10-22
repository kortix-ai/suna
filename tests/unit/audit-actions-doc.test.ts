import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// apps/web/content/docs/audit-actions.mdx is generated from the audit label
// catalog in packages/shared. A route added there without a regenerate leaves
// the public reference stale. Fix: bun apps/web/scripts/generate-audit-actions-doc.mjs

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('audit actions doc', () => {
  it('matches the audit label catalog', () => {
    expect(() =>
      execFileSync('bun', ['apps/web/scripts/generate-audit-actions-doc.mjs', '--check'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
