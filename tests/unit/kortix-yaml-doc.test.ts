import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cell } from '../../apps/web/scripts/docs-generated-region.mjs';

// The kortix.yaml key tables in apps/web/content/docs/developers.mdx (the
// generated:kortix-yaml region) are generated from the JSON Schema. A key or
// description changed in packages/manifest-schema/src/json-schema.ts without a
// regenerate leaves the public reference stale. Fix:
//   (cd packages/manifest-schema && bun run generate:schema)
//   bun apps/web/scripts/generate-kortix-yaml-doc.mjs

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DOC = 'apps/web/content/docs/developers.mdx';
const SCRIPT = 'apps/web/scripts/generate-kortix-yaml-doc.mjs';

function checkDoc(file: string) {
  return spawnSync('bun', [SCRIPT, file, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('kortix.yaml reference doc', () => {
  it('matches the JSON Schema', () => {
    expect(() =>
      execFileSync('bun', [SCRIPT, '--check'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('exits 1 on a stale region and 0 on a fresh copy of the same page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-yaml-doc-'));
    try {
      const page = join(dir, 'developers.mdx');
      const fresh = readFileSync(join(REPO_ROOT, DOC), 'utf8');
      writeFileSync(page, fresh);
      expect(checkDoc(page).status).toBe(0);

      // Stale only inside the region: an extra newline after the start marker.
      const start = '{/* generated:kortix-yaml:start */}';
      writeFileSync(page, fresh.replace(start, `${start}\n`));
      const stale = checkDoc(page);
      expect(stale.status).toBe(1);
      expect(`${stale.stderr}${stale.stdout}`).toMatch(/is stale/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps cell() strict: {, } or < outside a code span throws', () => {
    // KRTX-3734: an unspanned "{ exclude: [names] }" in a schema description
    // made this guard crash on every run, so real staleness hid behind it.
    // The schema side carries code spans; cell() stays the enforcer.
    expect(() => cell('a list of names, or { exclude: [names] } for every name but those.')).toThrow(
      /code span/,
    );
    const spanned = 'a list of names, or `{ exclude: [names] }` for every name but those.';
    expect(cell(spanned)).toBe(spanned);
  });
});
