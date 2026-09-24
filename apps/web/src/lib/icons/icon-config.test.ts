import { describe, expect, test } from 'bun:test';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_ICON_WEIGHT, ICON_WEIGHTS, SHIPPED_ICON_WEIGHTS } from './icon-config';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(tsx?|mdx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('icon-config', () => {
  test('exposes all six phosphor weights exactly once', () => {
    expect([...ICON_WEIGHTS].sort()).toEqual(
      ['bold', 'duotone', 'fill', 'light', 'regular', 'thin'].sort(),
    );
    expect(new Set(ICON_WEIGHTS).size).toBe(6);
  });

  test('default weight is one of the valid weights', () => {
    expect(ICON_WEIGHTS).toContain(DEFAULT_ICON_WEIGHT);
  });

  test('shipped weights include the default and fill', () => {
    expect(SHIPPED_ICON_WEIGHTS).toContain(DEFAULT_ICON_WEIGHT);
    expect(SHIPPED_ICON_WEIGHTS).toContain('fill');
  });

  // The browser bundle strips every other weight (phosphor-weights-loader).
  // A literal outside the list would render an empty icon, so it fails here.
  test('no source file asks for a weight the bundle does not ship', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const literal = /\bweight(?:=\{?|:\s*)['"](thin|light|regular|bold|fill|duotone)['"]/g;
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      for (const match of readFileSync(file, 'utf8').matchAll(literal)) {
        if (!SHIPPED_ICON_WEIGHTS.includes(match[1] as (typeof SHIPPED_ICON_WEIGHTS)[number])) {
          offenders.push(`${file.slice(root.length)}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
