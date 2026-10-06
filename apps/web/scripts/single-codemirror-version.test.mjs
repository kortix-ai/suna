import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every resolved copy of `@codemirror/state` and `@codemirror/view` in the
// workspace lockfile.
//
// The file editor (`apps/web/src/components/file-editors/code-editor.tsx`)
// builds extensions from apps/web's own `@codemirror/*` packages and passes
// them to `@uiw/react-codemirror`, whose `getExtensions` assembles the
// meta-package's `basicSetup` and calls `EditorState.create`. When the
// lockfile resolves TWO versions of an identity-carrying CodeMirror package,
// the copies carry distinct `Extension`/`Facet` classes and the `instanceof`
// check rejects the mixed set at runtime with "Unrecognized extension value
// in extension set" — the editor crashes on session pages (prod release
// dc3a82d6b, 2026-10-05, >220 client exceptions; release #9153 re-resolved
// the `codemirror@6.0.2` meta subtree to state 6.7.6/view 6.43.13 while the
// direct chain stayed on 6.7.5/6.43.12). The root `pnpm.overrides` pins each
// package to one version so every dependency path links the same copy —
// same guard as `single-next-version.test.mjs`.
export function resolvedCodemirrorVersions(lockfileText, packageName) {
  const versions = new Set();
  const pattern = new RegExp(`^ {2}/@codemirror/${packageName}@([^(:]+)`);
  for (const line of lockfileText.split('\n')) {
    const match = pattern.exec(line);
    if (match) versions.add(match[1]);
  }
  return [...versions].sort();
}

describe('resolvedCodemirrorVersions', () => {
  test('extracts only the real package, not codemirror-* packages', () => {
    const sample = [
      '  /@replit/codemirror-lang-nix@6.0.1(@codemirror/state@6.7.5):',
      '  /@uiw/codemirror-themes@4.23.10(@codemirror/state@6.7.5):',
      '  /@uiw/react-codemirror@4.25.11(@codemirror/state@6.7.5)(codemirror@6.0.2):',
      '  /codemirror@6.0.2:',
      '  /@codemirror/state@6.7.5:',
      '  /@codemirror/view@6.43.12(@codemirror/state@6.7.5):',
    ].join('\n');
    expect(resolvedCodemirrorVersions(sample, 'state')).toEqual(['6.7.5']);
    expect(resolvedCodemirrorVersions(sample, 'view')).toEqual(['6.43.12']);
  });

  test('reports a forked graph as multiple versions', () => {
    const sample = [
      '  /@codemirror/state@6.7.5:',
      '  /@codemirror/state@6.7.6:',
      '  /@codemirror/view@6.43.12:',
      '  /@codemirror/view@6.43.13:',
    ].join('\n');
    expect(resolvedCodemirrorVersions(sample, 'state')).toEqual(['6.7.5', '6.7.6']);
    expect(resolvedCodemirrorVersions(sample, 'view')).toEqual(['6.43.12', '6.43.13']);
  });
});

describe('workspace lockfile', () => {
  const lockfile = readFileSync(join(import.meta.dir, '../../../pnpm-lock.yaml'), 'utf8');

  test('resolves exactly one version of @codemirror/state', () => {
    expect(resolvedCodemirrorVersions(lockfile, 'state')).toHaveLength(1);
  });

  test('resolves exactly one version of @codemirror/view', () => {
    expect(resolvedCodemirrorVersions(lockfile, 'view')).toHaveLength(1);
  });
});
