import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// CodeMirror checks extensions with `instanceof`. Two copies of
// `@codemirror/state`, `@codemirror/view` or `@lezer/common` in one bundle make
// every editor throw "Unrecognized extension value in extension set", and the
// file viewer shows "Couldn't preview this file" for every code file. #8563 (a
// hono bump) re-resolved the lockfile into two copies and broke yaml/json
// previews on dev and prod. The root `pnpm.overrides` pin one version of each.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SINGLETONS = ['@codemirror/state', '@codemirror/view', '@lezer/common'];

describe('the CodeMirror singletons', () => {
  const lockfile = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');

  for (const name of SINGLETONS) {
    it(`resolves ${name} to exactly one version`, () => {
      const entry = new RegExp(`^  /${name.replace('/', '\\/')}@([^:(]+):$`, 'gm');
      const versions = [...lockfile.matchAll(entry)].map((match) => match[1]);
      expect(versions).toHaveLength(1);
    });
  }
});
