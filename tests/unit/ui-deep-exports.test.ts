import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readRepoFile } from '../src/fixtures/repo';

// @kortix/ui exports its module entries, its primitives and its stylesheets. A deep key
// (`@kortix/ui/<module>/<path>`, no semver) exists only for a module file a workspace
// consumer imports today: packages/ui/scripts/deep-exports.json lists them and
// gen-exports.mjs exports exactly that list. This test keeps the list equal to the imports:
// a new deep import must be added (or, better, imported from its entry), and a key nobody
// imports any more must leave the list.

const EXPORTS: Record<string, unknown> = JSON.parse(readRepoFile('packages/ui/package.json')).exports;
const DEEP: string[] = JSON.parse(readRepoFile('packages/ui/scripts/deep-exports.json')).keys;
const SPECIFIER = /['"`](@kortix\/ui(?:\/[\w./[\]-]+)?)['"`]/g;

const keyOf = (specifier: string) => `.${specifier.slice('@kortix/ui'.length)}`;
const isDeep = (key: string) => {
  const target = EXPORTS[key];
  return typeof target === 'string' && /\.tsx?$/.test(target) && !target.startsWith('./src/primitives/') &&
    key.split('/').length > 2;
};

function importedSpecifiers(): Map<string, string[]> {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.(tsx?|mts|mjs|cjs|js)$/.test(file) && !file.startsWith('packages/ui/dist/'));
  const found = new Map<string, string[]>();
  for (const file of files) {
    let source: string;
    try {
      source = readRepoFile(file);
    } catch {
      continue; // deleted in the working tree
    }
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      found.set(specifier!, [...(found.get(specifier!) ?? []), file]);
    }
  }
  return found;
}

describe('@kortix/ui deep exports', () => {
  const imports = importedSpecifiers();

  it('every imported @kortix/ui specifier is an export of the package', () => {
    const missing = [...imports]
      .filter(([specifier]) => specifier !== '@kortix/ui' && !(keyOf(specifier) in EXPORTS))
      .map(([specifier, files]) => `${specifier} (${files[0]})`);
    expect(missing).toEqual([]);
  });

  it('deep-exports.json lists exactly the deep keys tracked files import', () => {
    const used = [...new Set([...imports.keys()].map(keyOf).filter(isDeep))].sort();
    expect(DEEP.length).toBeGreaterThan(0);
    expect(DEEP).toEqual(used);
  });
});
