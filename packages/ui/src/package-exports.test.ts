import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- plain .mjs script, no declaration file
import { buildPublishExports } from '../scripts/gen-exports.mjs';

type Entry = string | { types: string; import: string };
interface Pkg {
  exports: Record<string, string>;
  publishConfig: { exports: Record<string, Entry>; main: string; types: string; files: string[] };
  dependencies: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Pkg;
const at = (target: string) => fileURLToPath(new URL(`../${target}`, import.meta.url));

// The workspace resolves `exports` (src/); `npm install @kortix/ui` resolves
// `publishConfig.exports` (dist/). A key in one map and not the other works in the
// monorepo and breaks only for an npm consumer.
test('exports and publishConfig.exports declare the same subpaths', () => {
  expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual(Object.keys(pkg.exports).sort());
});

test('publishConfig.exports is generated from exports (run: pnpm --filter @kortix/ui gen-exports)', () => {
  expect(pkg.publishConfig.exports).toEqual(buildPublishExports(pkg.exports));
});

test('every module entry declares types and import under dist/', () => {
  for (const [key, entry] of Object.entries(pkg.publishConfig.exports)) {
    if (typeof entry === 'string') {
      expect(`${key} → ${entry}`).toMatch(/(\.css|package\.json)$/);
      continue;
    }
    expect(Object.keys(entry).sort()).toEqual(['import', 'types']);
    expect(entry.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
    expect(entry.import).toMatch(/^\.\/dist\/.+\.js$/);
  }
});

test('the published manifest never depends on the private @kortix/shared (the build inlines it)', () => {
  expect(pkg.dependencies['@kortix/shared']).toBeUndefined();
});

// dist/ (except the committed styles.css) exists only after `pnpm --filter @kortix/ui build`.
// The packages lane builds before it runs this file; scripts/stage-npm-publish.mjs and
// scripts/smoke-install.mjs check the same targets on every publish.
test.skipIf(!existsSync(at('dist/index.js')))('every publishConfig target exists after the build', () => {
  const targets = [
    pkg.publishConfig.main,
    pkg.publishConfig.types,
    ...Object.values(pkg.publishConfig.exports).flatMap((e) => (typeof e === 'string' ? [e] : [e.types, e.import])),
  ];
  expect(targets.filter((t) => !existsSync(at(t)))).toEqual([]);
});
