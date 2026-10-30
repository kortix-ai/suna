import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// apps/web is a consumer of @kortix/ui: it imports `@kortix/ui/<entry>` (or a deep
// `@kortix/ui/<module>/<path>`) where it uses a component. A web file whose only content
// re-exports @kortix/ui is a shim, a second name for one package file. 1336 shims were
// deleted at once (branch kortix-ui-chat); this test keeps them from coming back.
//
// Allowed: `apps/web/src/ui/{index,types}.ts`, the session-type surface CLAUDE.md names
// (`@/ui`). A file that re-exports @kortix/sdk only is not a @kortix/ui shim.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const ALLOWED = new Set(['apps/web/src/ui/index.ts', 'apps/web/src/ui/types.ts']);

// One `import`/`export … from '@kortix/…'` statement, with or without a semicolon.
const FROM_KORTIX = /\b(?:export|import)\s+(?:type\s+)?(?:([\w$*{},\s]+?)\s+from\s+)?['"](@kortix\/[^'"]+)['"]\s*;?/g;

/**
 * True when `source` only re-exports or imports `@kortix/*` (one of them @kortix/ui),
 * plus at most a re-export of names it imported (`import X from …; export default X`).
 */
export function isUiShim(source: string): boolean {
  let code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*['"]use client['"];?/, '');
  const specifiers: string[] = [];
  const imported = new Set<string>();
  code = code.replace(FROM_KORTIX, (statement, bindings: string | undefined, specifier: string) => {
    specifiers.push(specifier);
    if (statement.startsWith('import') && bindings)
      for (const name of bindings.replace(/\b(?:type|as)\b|[{}*]/g, ' ').split(/[\s,]+/)) if (name) imported.add(name);
    return '';
  });
  // `export default X` / `export { X, Y }` of imported names re-exports them too.
  code = code.replace(/\bexport\s+(?:default\s+([\w$]+)|\{([^}]*)\})\s*;?/g, (statement, one?: string, many?: string) =>
    (one ? [one] : (many ?? '').split(',').map((name) => name.trim().split(/\s+as\s+/)[0]))
      .filter(Boolean)
      .every((name) => imported.has(name))
      ? ''
      : statement,
  );
  return code.trim() === '' && specifiers.some((specifier) => /^@kortix\/ui(\/|$)/.test(specifier));
}

describe('apps/web has no @kortix/ui shims', () => {
  it('detects every shim form and only shims', () => {
    for (const shim of [
      "export * from '@kortix/ui/button';",
      "'use client';\n\nexport * from '@kortix/ui/session';\nexport { default } from '@kortix/ui/session';",
      "/** Moved. */\nexport { Foo as Bar, type Baz } from '@kortix/ui/files';",
      "import '@kortix/ui/session/tool/tools/register';",
      "export * from '@kortix/ui';",
      "export * from '@kortix/ui/session'\nexport { default } from '@kortix/ui/session'\n",
      "export * from \"@kortix/ui/session\"",
      "import X from '@kortix/ui/session';\nexport default X;",
      "import { A, B as C } from '@kortix/ui/files'\nexport { A, C }",
    ])
      expect(isUiShim(shim)).toBe(true);
    for (const file of [
      "export * from '@kortix/sdk';",
      "export { cn } from '@kortix/ui';\nexport const x = 1;",
      "import { Button } from '@kortix/ui/button';\nexport function A() { return Button; }",
      "export * from './local';",
      "import X from '@kortix/ui/session';\nexport default function Y() { return X; }",
      "import { A } from '@kortix/ui/files';\nexport { A, Other };",
      '',
    ])
      expect(isUiShim(file)).toBe(false);
  });

  it('no tracked apps/web file only re-exports @kortix/ui', () => {
    const files = execFileSync('git', ['ls-files', '--', 'apps/web'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => /\.(tsx?|mts|jsx?|mjs)$/.test(file) && !file.endsWith('.d.ts') && !ALLOWED.has(file));
    expect(files.length).toBeGreaterThan(1000);
    const shims = files.filter((file) => {
      try {
        return isUiShim(readFileSync(join(REPO_ROOT, file), 'utf8'));
      } catch {
        return false; // deleted in the working tree, not yet in the index
      }
    });
    expect(shims).toEqual([]);
  });
});
