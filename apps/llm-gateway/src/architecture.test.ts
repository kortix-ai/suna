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
  test('core owns the catalog dependency and the standalone server does not duplicate it', () => {
    const appPackage = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const corePackage = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(corePackage.dependencies?.['@kortix/llm-catalog']).toBe('workspace:*');
    expect(corePackage.devDependencies?.['@kortix/llm-catalog']).toBeUndefined();
    expect(appPackage.dependencies?.['@kortix/llm-catalog']).toBeUndefined();
    expect(appPackage.devDependencies?.['@kortix/llm-catalog']).toBeUndefined();
  });

  test('standalone source accesses the catalog through the core gateway package', () => {
    const offenders = sourceFiles(join(appRoot, 'src')).filter((file) =>
      /(?:from\s*|import\s*)[('"`]@kortix\/llm-catalog/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
