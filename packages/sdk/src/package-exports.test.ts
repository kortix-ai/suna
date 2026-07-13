import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Pkg {
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
}

function pkg(): Pkg {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as Pkg;
}

test('exports and publishConfig.exports declare the same subpaths', () => {
  const { exports: src, publishConfig } = pkg();
  // A subpath present in one map and absent from the other is invisible in the
  // workspace (which resolves `exports` → src/) and only explodes for someone
  // who ran `npm install @kortix/sdk` (which resolves publishConfig → dist/).
  expect(Object.keys(publishConfig.exports).sort()).toEqual(Object.keys(src).sort());
});

test('every publishConfig entry declares both types and import', () => {
  const { publishConfig } = pkg();
  for (const [subpath, entry] of Object.entries(publishConfig.exports)) {
    expect(typeof entry === 'object' && entry !== null ? Object.keys(entry).sort() : null).toEqual([
      'import',
      'types',
    ]);
    const { types, import: imp } = entry as { types: string; import: string };
    expect(types.startsWith('./dist/') && types.endsWith('.d.ts')).toBe(true);
    expect(imp.startsWith('./dist/') && imp.endsWith('.js')).toBe(true);
  }
});
