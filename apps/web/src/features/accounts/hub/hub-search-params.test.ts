// Everything the account hub renders must read its own state through
// `useHubSearchParams()`, never through `useSearchParams()`.
//
// The hub writes prefixed params onto the page URL (`accountTab`,
// `accountProvider`, …) and `useHubSearchParams()` translates them back to the
// short names. A pane that calls `useSearchParams().get('provider')` reads a
// param that is never on the URL and silently gets `null`. That is exactly how
// the SSO/SCIM wizards broke on 2026-09-14: every provider click wrote
// `accountProvider=entra`, the wizard read `provider`, and the picker rendered
// again forever.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const webSrc = join(import.meta.dir, '../../..');

/** Directories whose components render inside the account hub modal. */
const HUB_RENDERED_DIRS = ['features/accounts/hub', 'features/sso-setup', 'components/iam'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The short keys, read from the one alias table in the store. */
function hubParamKeys(): string[] {
  const store = readFileSync(join(webSrc, 'stores/account-panel-store.ts'), 'utf8');
  const table = store.match(/const HUB_PARAM_ALIASES = \{([\s\S]*?)\} as const/);
  if (!table) throw new Error('HUB_PARAM_ALIASES not found in account-panel-store.ts');
  return [...table[1].matchAll(/^\s*(\w+): 'account\w+',$/gm)].map((m) => m[1]);
}

describe('hub panes read hub state through useHubSearchParams()', () => {
  const keys = hubParamKeys();

  test('the alias table parses to every hub key', () => {
    expect(keys.sort()).toEqual(['from', 'group', 'member', 'project', 'provider', 'setup', 'tab']);
  });

  test('no hub-rendered file reads a short hub key off the raw URL', () => {
    const readKey = new RegExp(`\\.get\\(\\s*['"](${keys.join('|')})['"]\\s*\\)`);
    const offenders: string[] = [];
    for (const dir of HUB_RENDERED_DIRS) {
      for (const file of sourceFiles(join(webSrc, dir))) {
        const source = readFileSync(file, 'utf8');
        const importsRawParams = /import\s*\{[^}]*\buseSearchParams\b[^}]*\}\s*from\s*'next\/navigation'/.test(
          source,
        );
        if (importsRawParams && readKey.test(source)) offenders.push(relative(webSrc, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the setup wizard takes its provider from the hub params', () => {
    const wizard = readFileSync(join(webSrc, 'features/sso-setup/setup-wizard.tsx'), 'utf8');
    expect(wizard.includes("useHubSearchParams().get('provider')")).toBe(true);
    expect(/import\s*\{[^}]*\buseSearchParams\b[^}]*\}\s*from\s*'next\/navigation'/.test(wizard)).toBe(
      false,
    );
  });
});
