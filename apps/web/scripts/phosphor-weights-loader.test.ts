import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { stripWeights } = require('./phosphor-weights-loader.cjs') as {
  stripWeights: (source: string, keep: string[]) => string;
};

const defsPath = require
  .resolve('@phosphor-icons/react/package.json')
  .replace(/package\.json$/, 'dist/defs/Acorn.es.js');
const acorn = readFileSync(defsPath, 'utf8');

// Evaluates a defs module with a stub React and returns its Map's keys.
function weightsOf(source: string): string[] {
  const body = source
    .replace(/import \* as (\w+) from "react";/, 'const $1 = __react;')
    .replace(/export \{\s*(\w+) as default\s*\};?/, 'return $1;');
  const map = new Function('__react', body)({ createElement: () => null, Fragment: 'F' }) as Map<
    string,
    unknown
  >;
  return [...map.keys()].sort();
}

describe('phosphor-weights-loader', () => {
  test('the real defs module carries all six weights', () => {
    expect(weightsOf(acorn)).toEqual(['bold', 'duotone', 'fill', 'light', 'regular', 'thin']);
  });

  test('keeps only the requested weights and stays valid JavaScript', () => {
    const out = stripWeights(acorn, ['regular', 'bold', 'fill', 'duotone']);
    expect(weightsOf(out)).toEqual(['bold', 'duotone', 'fill', 'regular']);
    expect(out.length).toBeLessThan(acorn.length);
  });

  test('keeps the kept entries byte-identical', () => {
    const out = stripWeights(acorn, ['regular', 'bold', 'fill', 'duotone']);
    const boldEntry = acorn.match(/\n {2}\[\n {4}"bold",\n[\s\S]*?\n {2}\]/)![0];
    expect(out).toContain(boldEntry);
  });

  test('strips every icon the installed package ships', () => {
    const dir = dirname(defsPath);
    const files = readdirSync(dir).filter((f) => f.endsWith('.es.js'));
    expect(files.length).toBeGreaterThan(1000);
    const failures = files.filter((file) => {
      const out = stripWeights(readFileSync(join(dir, file), 'utf8'), [
        'regular',
        'bold',
        'fill',
        'duotone',
      ]);
      return weightsOf(out).join() !== 'bold,duotone,fill,regular';
    });
    expect(failures).toEqual([]);
  });

  test('returns an unexpected shape unchanged', () => {
    const odd = 'const a = new Map([["bold", 1]]);\nexport { a as default };\n';
    expect(stripWeights(odd, ['bold'])).toBe(odd);
  });
});
