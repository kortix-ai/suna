import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- plain .mjs script, no declaration file
import { buildExports, INTERNAL as INTERNAL_MODULES } from '../scripts/gen-exports.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('package.json exports', () => {
  test('match the file tree (run: pnpm --filter @kortix/ui gen-exports)', () => {
    expect(pkg.exports).toEqual(buildExports());
  });

  test('every target exists in a fresh checkout', () => {
    const missing = Object.values<string>(pkg.exports).filter(
      (target) => !existsSync(fileURLToPath(new URL(`../${target}`, import.meta.url))),
    );
    expect(missing).toEqual([]);
  });

  // buildExports() only walks known roots and extensions, so the drift test above
  // cannot see a module it skips. This walks every file under src/ instead.
  test('every source file is an export target or a listed internal', () => {
    // './src/...' paths that are deliberately not exported (gen-exports INTERNAL).
    const INTERNAL = new Set<string>([...(INTERNAL_MODULES as Set<string>)].map((p) => `./src/${p}`));
    const SKIP = /\.test\.tsx?$|\.d\.ts$|\/__snapshots__\/|^\.\/src\/test-utils\/|^\.\/src\/(chat|i18n)\/(?!index\.tsx?$)/;
    const src = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => `./src/${relative(src, join(d.parentPath, d.name)).split(sep).join('/')}`)
      .filter((p) => !SKIP.test(p) && !INTERNAL.has(p));
    const targets = new Set(Object.values<string>(pkg.exports));
    expect(files.filter((p) => !targets.has(p))).toEqual([]);
  });

  test('dist/styles.css matches a fresh build (run: pnpm --filter @kortix/ui build:styles)', () => {
    const run = spawnSync('node', [fileURLToPath(new URL('../scripts/build-styles.mjs', import.meta.url)), '--check'], {
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
