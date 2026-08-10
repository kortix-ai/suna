import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
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
  test('the standalone gateway delegates catalog capability handling to core', () => {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@kortix/llm-catalog']).toBeUndefined();
    expect(pkg.devDependencies?.['@kortix/llm-catalog']).toBeUndefined();
  });

  test('catalog imports stay inside the core AI-SDK transport', () => {
    const appImports = sourceFiles(join(appRoot, 'src')).filter((file) =>
      /(?:from\s*|import\s*)[('"`]@kortix\/llm-catalog/.test(readFileSync(file, 'utf8')),
    );
    expect(appImports).toEqual([]);

    const coreImports = sourceFiles(join(coreRoot, 'src')).filter((file) =>
      /(?:from\s*|import\s*)[('"`]@kortix\/llm-catalog/.test(readFileSync(file, 'utf8')),
    );
    expect(coreImports.length).toBeGreaterThan(0);
    expect(
      coreImports.every((file) => file.startsWith(join(coreRoot, 'src', 'transports', 'ai-sdk'))),
    ).toBe(true);
  });
});
