import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { locales } from './catalog.mjs';
import { CATALOG_LOADERS } from './catalog-loaders';

describe('CATALOG_LOADERS', () => {
  test('has exactly one loader per supported locale', () => {
    expect(Object.keys(CATALOG_LOADERS).sort()).toEqual([...locales].sort());
  });

  test('the per-locale catalog import table exists exactly once in src/i18n', () => {
    // The bundler emits one chunk per literal `import()` of a catalog JSON.
    // The table must stay the only place holding those imports — a second
    // table duplicates the chunks in the build output.
    const sources = readdirSync(import.meta.dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => ({ file, source: readFileSync(join(import.meta.dir, file), 'utf8') }))
      .filter(({ source }) =>
        source.includes("import('../../" + "translations/"),
      );
    expect(sources.map(({ file }) => file)).toEqual(['catalog-loaders.ts']);
  });
});
