import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every stack in the app is expo-router's native `Stack` with the platform
 * default transition, on iOS and Android. This guard fails when a file
 * brings back the JS card stack or a custom card transition.
 */

const APP_ROOT = join(import.meta.dir, '..', '..');
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks', 'contexts'];
const SELF = relative(APP_ROOT, import.meta.path);

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const CUSTOM_CARD_OPTION = /\b(?:cardStyleInterpolator|transitionSpec)\s*:/;

function isBannedSpecifier(specifier: string): boolean {
  return (
    specifier === 'expo-router/js-stack' ||
    specifier === '@react-navigation/stack' ||
    specifier.startsWith('@react-navigation/stack/') ||
    specifier.endsWith('navigation/stack-transitions')
  );
}

/** Import specifiers in `source` that load the JS stack or its transition module. */
function bannedImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    if (isBannedSpecifier(match[1])) found.push(match[1]);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(APP_ROOT, dir)))
  .map((path) => relative(APP_ROOT, path))
  .filter((path) => path !== SELF);

describe('native stack only', () => {
  test('the matcher flags every banned import form', () => {
    expect(bannedImports(`import JsStack from 'expo-router/js-stack';`)).toEqual([
      'expo-router/js-stack',
    ]);
    expect(bannedImports(`import { x } from "@react-navigation/stack";`)).toEqual([
      '@react-navigation/stack',
    ]);
    expect(
      bannedImports(`import { AppStack } from '@/components/navigation/stack-transitions';`)
    ).toEqual(['@/components/navigation/stack-transitions']);
    expect(bannedImports(`const s = require('expo-router/js-stack');`)).toEqual([
      'expo-router/js-stack',
    ]);
    expect(bannedImports(`import { Stack } from 'expo-router';`)).toEqual([]);
  });

  test('the scan reads the app source tree', () => {
    expect(files).toContain('app/_layout.tsx');
    expect(files).toContain('components/session/ProjectScreen.tsx');
  });

  test('no source file imports the JS stack or stack-transitions', () => {
    const offenders = files.flatMap((path) =>
      bannedImports(readFileSync(join(APP_ROOT, path), 'utf8')).map((spec) => `${path}: ${spec}`)
    );
    expect(offenders).toEqual([]);
  });

  test('no source file sets a custom card transition', () => {
    const offenders = files.filter((path) =>
      CUSTOM_CARD_OPTION.test(readFileSync(join(APP_ROOT, path), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  test('the transition module is deleted', () => {
    expect(existsSync(join(APP_ROOT, 'components/navigation/stack-transitions.ts'))).toBe(false);
  });
});
