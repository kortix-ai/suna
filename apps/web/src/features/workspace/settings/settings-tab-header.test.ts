/**
 * Enforces the fix for "every settings pane opens with no page heading" (see
 * `settings-tab-header.tsx`'s header comment): every `*-tab.tsx` pane must
 * render `<SettingsTabHeader tab="…">` with the `tab` id it actually mounts
 * under in `settings-panel.tsx`'s `SettingsTabPane` switch — not guessed from
 * the filename. Filenames and tab ids have diverged before (`api-keys-tab.tsx`
 * mounted on `api-keys`, `connected-tab.tsx` on `connected`), which is exactly
 * why the id is read off the switch, never inferred.
 *
 * **Source-level, not a render sweep.** `ModelsTabView` delegates its whole
 * body to a hook-driven slot (`LlmManagementView`) that needs a
 * `QueryClientProvider` this suite doesn't have — see `models-tab.test.tsx`,
 * which stands a marker `<div>` in for the slot instead of asserting on the
 * real child. Grepping the stripped source for the exact JSX usage is the one
 * mechanism that reaches all 17 files the same way, real slot or not.
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
 * read off that switch, not guessed from the filename.
 *
 * Eight files left this table with the tabs they rendered:
 * `organization-tab.tsx`, `billing-tab.tsx`, `usage-tab.tsx`,
 * `groups-tab.tsx`, `roles-tab.tsx`, `identity-tab.tsx`, `audit-tab.tsx` and
 * `api-keys-tab.tsx`. All eight configured the ACCOUNT, and the account
 * already renders every one of them at `/accounts/[id]` — so the modules were
 * deleted rather than left mounted from nowhere. Two more left it without
 * being deleted: `models-tab.tsx` graduated a SECOND time, off
 * `/projects/[id]/config` and onto its own top-level Customize tab, so no
 * registry `SettingsTabHeader` reads has a `models` entry any more — it
 * renders a hardcoded heading instead (see that file's header comment).
 * `snapshots-tab.tsx` merged INTO the `sandbox` section — `sandbox-tab.tsx`,
 * mounted directly above it wherever `sandbox` renders, owns the one shared
 * heading for both now. `members-tab.tsx` graduated the same second way
 * `models-tab.tsx` did — off `/projects/[id]/config` and onto its own
 * top-level Customize tab (`/projects/[id]/members`) — then graduated a THIRD
 * time and a FOURTH: first to a hardcoded `CapabilityPageShell` heading (same
 * fix as `models-tab.tsx`), then off the project entirely, onto the account
 * hub's Access tab (`/accounts/[id]?tab=access-projects`).
 * `/projects/[id]/members` is a bare redirect now and `members-tab.tsx` is
 * deleted, so it is gone from this file rather than listed as an absent
 * heading. The `every tab file on disk is classified` case below is what
 * keeps this table honest: a file that still renders `SettingsTabHeader` and
 * is missing here fails immediately — swap that assertion's message if you
 * touch it, since two files (`models-tab.tsx`, `snapshots-tab.tsx`) are now
 * deliberately absent despite being on disk.
 */
const TAB_ID_FOR_FILE: Record<string, string> = {
  'appearance-tab.tsx': 'appearance',
  'connected-tab.tsx': 'connected',
  // Renamed on the move to `/projects/[id]/config`: the section is called
  // "Feature flags" there, which is also the `CustomizeSection` id it has
  // always gated on. `SettingsTabHeader` resolves it through the
  // project-settings registry rather than the rail.
  'experimental-tab.tsx': 'feature-flags',
  'general-tab.tsx': 'general',
  'credits-tab.tsx': 'credits',
  'plan-tab.tsx': 'plan',
  'preferences-tab.tsx': 'preferences',
  'profile-tab.tsx': 'profile',
  'sandbox-tab.tsx': 'sandbox',
  'security-tab.tsx': 'security',
  'sessions-tab.tsx': 'sessions',
  'tokens-tab.tsx': 'tokens',
};

/** Files on disk that deliberately do NOT render `SettingsTabHeader` any
 *  more — see the table's header comment for why each one is here instead of
 *  in `TAB_ID_FOR_FILE`. `members-tab.tsx` is not here: it is deleted, not
 *  present-but-headingless — see the table's header comment. */
const FILES_WITHOUT_REGISTRY_HEADING = ['models-tab.tsx', 'snapshots-tab.tsx'];

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
    expect(onDisk).toEqual(
      [...Object.keys(TAB_ID_FOR_FILE), ...FILES_WITHOUT_REGISTRY_HEADING].sort(),
    );
  });

  for (const file of FILES_WITHOUT_REGISTRY_HEADING) {
    test(`${file} does NOT render SettingsTabHeader — its heading moved elsewhere`, () => {
      const source = strippedSource(file);
      expect(source).not.toContain("import { SettingsTabHeader } from '../settings-tab-header';");
    });
  }

  // The `billing-tab.tsx` multi-branch case is gone with the file. It pinned
  // that all three of its top-level returns (loading, error, success) carried
  // a heading. Billing renders on `/accounts/[id]?tab=billing` now, where the
  // pane heading comes from that page's `PANE_META` and is drawn ABOVE the
  // branch — one heading for every state, so the class of defect that case
  // guarded cannot occur there.
});
