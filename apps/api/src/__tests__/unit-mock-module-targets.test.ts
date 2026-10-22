// `mock.module('<path>')` registers a mock under whatever path it is given. When
// the path no longer resolves (the module moved), the mock applies to nothing
// and the test silently runs against the real module. Every literal target in
// this package must resolve from the file that names it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');
const TARGET = /mock\.module\(\s*(['"`])([^'"`$\n]+)\1/g;

describe('mock.module targets', () => {
  test('every literal mock.module target resolves', () => {
    const unresolved: string[] = [];
    let count = 0;
    for (const file of new Bun.Glob('**/*.ts').scanSync(SRC)) {
      const path = join(SRC, file);
      const source = readFileSync(path, 'utf8');
      if (!source.includes('mock.module(')) continue;
      for (const match of source.matchAll(TARGET)) {
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        if (/^\s*(\*|\/\/)/.test(source.slice(lineStart, match.index))) continue; // a comment example
        count++;
        try {
          Bun.resolveSync(match[2], dirname(path));
        } catch {
          const line = source.slice(0, lineStart).split('\n').length;
          unresolved.push(`${relative(SRC, path)}:${line} ${match[2]}`);
        }
      }
    }
    // A broken scan must not pass with nothing checked.
    expect(count).toBeGreaterThan(1000);
    expect(unresolved).toEqual([]);
  });
});
