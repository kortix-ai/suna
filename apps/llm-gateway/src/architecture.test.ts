import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const coreRoot = resolve(import.meta.dir, '../../../packages/llm-gateway');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('gateway catalog boundary', () => {
  test('core and standalone gateway have no llm-catalog package dependency', () => {
    for (const root of [appRoot, coreRoot]) {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.['@kortix/llm-catalog']).toBeUndefined();
      expect(pkg.devDependencies?.['@kortix/llm-catalog']).toBeUndefined();
    }
  });

  test('core and standalone source never import the product catalog', () => {
    const offenders = [join(appRoot, 'src'), join(coreRoot, 'src')]
      .flatMap(sourceFiles)
      .filter((file) => /(?:from\s*|import\s*)[('"`]@kortix\/llm-catalog/.test(
        readFileSync(file, 'utf8'),
      ));
    expect(offenders).toEqual([]);
  });
});
