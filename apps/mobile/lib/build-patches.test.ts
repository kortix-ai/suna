import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The repo root .npmrc sets ignore-scripts=true, so pnpm skips this package's
// postinstall on EAS. Store builds get the patches only through EAS's own
// eas-build-post-install hook, which EAS runs explicitly.
const root = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// `@scope+name+1.2.3.patch` → { name: '@scope/name', version: '1.2.3' }
function parsePatchName(file: string) {
  const base = file.replace(/\.patch$/, '');
  const at = base.lastIndexOf('+');
  return { name: base.slice(0, at).replace(/\+/g, '/'), version: base.slice(at + 1) };
}

describe('build patches', () => {
  test('EAS runs patch-package through its post-install hook', () => {
    expect(pkg.scripts['eas-build-post-install']).toBe('patch-package');
  });

  test('a failed patch fails the install instead of shipping unpatched code', () => {
    expect(pkg.scripts.postinstall).toBe('patch-package');
  });

  test('every patched package is pinned to the exact version its patch targets', () => {
    const patches = readdirSync(join(root, 'patches')).filter((file) => file.endsWith('.patch'));
    expect(patches.length).toBeGreaterThan(0);
    for (const file of patches) {
      const { name, version } = parsePatchName(file);
      const declared = pkg.dependencies[name] ?? pkg.devDependencies?.[name];
      // A patch on a transitive dependency has no direct pin to check.
      if (declared === undefined) continue;
      expect(`${name}@${declared}`).toBe(`${name}@${version}`);
    }
  });
});
