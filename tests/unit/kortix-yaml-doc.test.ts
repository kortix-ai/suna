import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The kortix.yaml key tables in apps/web/content/docs/index.mdx (the
// generated:kortix-yaml region) are generated from the v3 JSON Schema. A key or
// description changed in packages/manifest-schema/src/json-schema.ts without a
// regenerate leaves the public reference stale. Fix:
//   (cd packages/manifest-schema && bun run generate:schema)
//   bun apps/web/scripts/generate-kortix-yaml-doc.mjs

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('kortix.yaml reference doc', () => {
  it('matches the v3 JSON Schema', () => {
    expect(() =>
      execFileSync('bun', ['apps/web/scripts/generate-kortix-yaml-doc.mjs', '--check'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
