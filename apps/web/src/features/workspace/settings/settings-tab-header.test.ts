/**
 * Enforces the fix for "every settings pane opens with no page heading" (see
 * `settings-tab-header.tsx`'s header comment): every `*-tab.tsx` pane must
 * render `<SettingsTabHeader tab="…">` with the `tab` id it actually mounts
 * under in `settings-panel.tsx`'s `SettingsTabPane` switch — not guessed from
 * the filename. Two tabs share a rail LABEL with a different tab ("General"
 * is both `general` and `organization`'s label — see `rail.ts`), which is
 * exactly why the id is read off the switch, never inferred.
 *
 * **Source-level, not a render sweep.** `InstructionsTabView`/`ModelsTabView`
 * delegate their whole body to a hook-driven slot (`CommandsView`/
 * `LlmManagementView`) that needs a `QueryClientProvider` this suite doesn't
 * have — see `instructions-tab.test.tsx`/`models-tab.test.tsx`, which stand a
 * marker `<div>` in for the slot instead of asserting on the real child.
 * Grepping the stripped source for the exact JSX usage is the one mechanism
 * that reaches all 18 files the same way, real slot or not.
 *
 * **Comments are stripped before matching.** A doc comment that quotes
 * `<SettingsTabHeader tab="x" />` verbatim would otherwise satisfy the
 * assertion with the real code deleted — the exact trap this effort's brief
 * calls out by name. Verified by hand, not assumed: temporarily deleting the
 * `<SettingsTabHeader tab="profile" />` line from `profile-tab.tsx` (leaving
 * every comment in that file untouched) turns this file's `profile-tab.tsx`
 * test red, and turns it green again the moment the line is restored — see
 * this task's report for the exact command run.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TABS_DIR = join(import.meta.dir, 'tabs');

/**
 * Every `*-tab.tsx` on disk, mapped to the exact `SettingsTab` id
 * `settings-panel.tsx`'s `SettingsTabPane` switch mounts that file under —
 * read off that switch (and the account-scoped branch above it), not
 * guessed from the filename. `organization-tab.tsx` mounts on tab id
 * `organization` even though its rail LABEL is "General", same as
 * `general-tab.tsx`'s — the two are different tabs with the same label,
 * disambiguated only by the Organization/Workspace group heading in the
 * rail (see `rail.ts`'s `RailItem.description` doc comment).
 */
const TAB_ID_FOR_FILE: Record<string, string> = {
  'api-keys-tab.tsx': 'api-keys',
  'audit-tab.tsx': 'audit',
  'billing-tab.tsx': 'billing',
  'connected-tab.tsx': 'connected',
  'experimental-tab.tsx': 'experimental',
  'general-tab.tsx': 'general',
  'groups-tab.tsx': 'groups',
  'identity-tab.tsx': 'identity',
  'instructions-tab.tsx': 'instructions',
  'members-tab.tsx': 'members',
  'models-tab.tsx': 'models',
  'organization-tab.tsx': 'organization',
  'preferences-tab.tsx': 'preferences',
  'profile-tab.tsx': 'profile',
  'roles-tab.tsx': 'roles',
  'sandbox-tab.tsx': 'sandbox',
  'snapshots-tab.tsx': 'snapshots',
  'usage-tab.tsx': 'usage',
};

/**
 * Strip block comments, line comments, and JSX comment blocks before
 * matching — see this file's header comment for why. Same three-pass strip
 * `models-tab.test.tsx` already uses against this exact class of trap.
 */
function strippedSource(file: string): string {
  return readFileSync(join(TABS_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
}

// NOTE: deliberately plain `for … of` + `test()`, not `test.each` — see
// `tab-content-width.test.ts`'s identical note on the `@types/bun` baseline
// this effort must hold at exactly 15.
describe('settings tab pane heading', () => {
  for (const [file, tabId] of Object.entries(TAB_ID_FOR_FILE)) {
    test(`${file} renders SettingsTabHeader for tab="${tabId}"`, () => {
      const source = strippedSource(file);
      expect(source).toContain("import { SettingsTabHeader } from '../settings-tab-header';");
      expect(source).toMatch(new RegExp(`<SettingsTabHeader\\b[^>]*\\btab="${tabId}"`));
    });
  }

  test('every tab file on disk is classified — a new tab cannot silently ship with no heading', () => {
    const onDisk = readdirSync(TABS_DIR)
      .filter((f) => f.endsWith('-tab.tsx') && !f.endsWith('.test.tsx'))
      .sort();
    expect(onDisk).toEqual(Object.keys(TAB_ID_FOR_FILE).sort());
  });

  /**
   * `billing-tab.tsx` returns early for loading and error states before its
   * main return — three separate top-level `return (…)` blocks a user can
   * land on as the Billing tab. A heading only in the main branch would
   * leave the loading and error states unlabelled. See this tab's own header
   * comment on `BillingTabView`.
   */
  test('billing-tab.tsx renders the heading in all three return branches — loading, error, and success', () => {
    const source = strippedSource('billing-tab.tsx');
    const matches = source.match(/<SettingsTabHeader\b[^>]*\btab="billing"/g) ?? [];
    expect(matches.length).toBe(3);
  });
});
