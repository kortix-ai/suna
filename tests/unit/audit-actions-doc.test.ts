import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/fixtures/repo';

// apps/web/content/docs/audit-actions.mdx is generated from the audit label
// catalog in packages/shared. A route added there without a regenerate leaves
// the public reference stale. Fix: bun apps/web/scripts/generate-audit-actions-doc.mjs

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
