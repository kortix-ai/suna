import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ACCOUNT_GRADUATED,
  SETTINGS_TABS,
  isAccountGraduatedSection,
  legacySectionRedirect,
  parseSettingsTab,
} from './settings-tabs';

describe('settings route segments', () => {
  test('every tab id is a usable URL segment', () => {
    for (const tab of SETTINGS_TABS) {
      expect(tab).toMatch(/^[a-z0-9-]+$/);
      expect(parseSettingsTab(tab)).toBe(tab);
    }
  });

  test('an unknown segment does not resolve to a tab', () => {
    expect(parseSettingsTab('nope')).toBeNull();
    expect(parseSettingsTab('Members')).toBeNull();
  });
});

/**
 * The `[tab]` route cannot be rendered here (no DOM harness; it is a client
 * component whose whole body is an effect), so this scans its source — the
 * same idiom `general-tab.rename.test.tsx` uses.
 *
 * What it pins: a segment that is not a live tab but IS a known legacy id must
 * go through `legacySectionRedirect`, not to the default tab. `main` (#6313)
 * graduated `computers` out of settings and into the Connectors page, and this
 * branch carried its own `/settings/computers` href until that merge — so
 * bookmarks of that URL exist and must land where computers actually lives.
 */
describe('the project settings [tab] route resolves legacy segments', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../app/(app)/projects/[id]/settings/[tab]/page.tsx'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('an unparseable segment tries the legacy redirect before the bare fallback', () => {
    // The route calls `useLegacySectionRedirect`, not `legacySectionRedirect`
    // directly: eight of the legacy ids resolve to `/accounts/[id]` and need
    // an account id this route does not have in hand. The hook resolves one.
    expect(code).toContain('useLegacySectionRedirect(projectId,');
    expect(code).toContain('?? `/projects/${projectId}/settings`');
  });

  /**
   * The fallback must not fire while the account id is still resolving, or a
   * `/settings/billing` bookmark lands on the bare overlay instead of the
   * account page it names — the exact silent-drop this whole redirect path
   * exists to prevent. The guard is one line and easy to delete, so it is
   * pinned in source.
   */
  test('the route waits for a pending account-scoped redirect instead of falling back', () => {
    expect(code).toContain('if (legacy.pending) return;');
    // And the resolution it waits on really does classify those ids.
    expect(isAccountGraduatedSection('billing')).toBe(true);
    expect(isAccountGraduatedSection('api-keys')).toBe(true);
    expect(isAccountGraduatedSection('computers')).toBe(false);
  });

  test('and the resolution it delegates to sends computers to Connectors', () => {
    expect(parseSettingsTab('computers')).toBeNull();
    expect(legacySectionRedirect('p1', 'computers')).toBe('/projects/p1/connectors');
  });

  test('a genuinely unknown segment still has nowhere to go but the default tab', () => {
    expect(legacySectionRedirect('p1', 'nope')).toBeNull();
  });
});

/**
 * The other half of the account redirect: a `?tab=` value the account page
 * does not accept is silently swallowed. `app/(app)/accounts/[id]/page.tsx`
 * filters `searchParams.get('tab')` against its own `VALID_TABS` and falls
 * back to Members for anything else — no error, no log. So a typo in
 * `ACCOUNT_GRADUATED` would send every `/settings/audit` bookmark to the
 * member roster and look exactly like a working redirect.
 *
 * Nothing links the two lists at the type level (they are different modules
 * with different vocabularies), so this reads the page's own source and pins
 * the join.
 */
describe('every account redirect names a tab the account page accepts', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../app/(app)/accounts/[id]/page.tsx'),
    'utf8',
  );

  // `const VALID_TABS = [ … ] as const;` — the page's own allowlist.
  const block = source.match(/const VALID_TABS = \[([\s\S]*?)\] as const;/);
  const validTabs = [...(block?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

  test('the page still declares a VALID_TABS allowlist this test can read', () => {
    // Guards the regex above: a refactor that renames or reshapes the constant
    // must fail here rather than silently reduce the join below to nothing.
    expect(block).not.toBeNull();
    expect(validTabs).toContain('members');
    expect(validTabs.length).toBeGreaterThanOrEqual(8);
  });

  test('every ACCOUNT_GRADUATED target is in that allowlist', () => {
    for (const [legacyId, tab] of Object.entries(ACCOUNT_GRADUATED)) {
      expect(validTabs, `${legacyId} -> ?tab=${tab}`).toContain(tab);
    }
  });

  test('and the redirect builds exactly that URL', () => {
    expect(legacySectionRedirect('p1', 'audit', 'acc1')).toBe('/accounts/acc1?tab=audit');
    expect(legacySectionRedirect('p1', 'organization', 'acc1')).toBe('/accounts/acc1?tab=settings');
    expect(legacySectionRedirect('p1', 'api-keys', 'acc1')).toBe('/accounts/acc1?tab=tokens');
    expect(legacySectionRedirect('p1', 'usage', 'acc1')).toBe('/accounts/acc1?tab=transactions');
  });
});
