/**
 * The settings panel keeps ONE visual coordinate system: switching tabs must not
 * move the content column around.
 *
 * Before this test the 16 tabs used FOUR different widths — `max-w-lg`,
 * `max-w-2xl`, `max-w-4xl`, and a lone `max-w-6xl` on Usage. Going
 * Profile (32rem) -> Members (56rem) -> Usage (72rem) shifted the column by up
 * to 40rem. Every file was individually defensible; the set had no rule.
 *
 * Jay's call (2026-08-10): two tiers, one rule.
 *
 *   FORMS  `max-w-2xl` — single-column settings, the width the design system
 *          already prescribes (`.claude/skills/kortix-design-system/SKILL.md`,
 *          "Container: mx-auto w-full max-w-2xl").
 *   TABLES `max-w-4xl` — surfaces with a real table or a dense list, which
 *          genuinely need the horizontal room.
 *
 * This test exists because the rule is otherwise unenforceable: a new tab that
 * picks its own width compiles, renders, and passes every other test. Adding a
 * tab means adding it to one of the two lists below — deliberately, not by
 * copying whichever neighbour you happened to open first.
 *
 * Two tabs delegate their container to a child view and so declare no width of
 * their own; they are listed as such rather than omitted, so a future reader
 * can tell "delegates" apart from "forgotten".
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TABS_DIR = join(import.meta.dir, 'tabs');

/** Single-column settings. The design system's default container. */
const FORM_TABS = [
  'billing-tab.tsx',
  'connected-tab.tsx',
  'experimental-tab.tsx',
  'general-tab.tsx',
  'organization-tab.tsx',
  'preferences-tab.tsx',
  'profile-tab.tsx',
];

/** Tables and dense lists, which need the extra horizontal room. */
const TABLE_TABS = [
  'api-keys-tab.tsx',
  'audit-tab.tsx',
  'groups-tab.tsx',
  'identity-tab.tsx',
  'members-tab.tsx',
  'roles-tab.tsx',
  'sandbox-tab.tsx',
  'snapshots-tab.tsx',
  'usage-tab.tsx',
];

/** Render a child view that brings its own container, so they declare no width. */
const DELEGATING_TABS = ['instructions-tab.tsx', 'models-tab.tsx'];

function firstContainerWidth(file: string): string | null {
  const source = readFileSync(join(TABS_DIR, file), 'utf8');
  // Only the outermost `mx-auto w-full max-w-*` counts — inner `max-w-*` on a
  // paragraph or a field is a different concern and must not be picked up.
  const match = source.match(/mx-auto w-full (max-w-[a-z0-9]+)/);
  return match ? match[1] : null;
}

describe('settings tab content width', () => {
  test.each(FORM_TABS)('%s is a form tab at max-w-2xl', (file) => {
    expect(firstContainerWidth(file)).toBe('max-w-2xl');
  });

  test.each(TABLE_TABS)('%s is a table tab at max-w-4xl', (file) => {
    expect(firstContainerWidth(file)).toBe('max-w-4xl');
  });

  test.each(DELEGATING_TABS)('%s delegates its container to a child view', (file) => {
    expect(firstContainerWidth(file)).toBeNull();
  });

  test('every tab file is classified — a new tab cannot silently pick its own width', () => {
    const onDisk = readdirSync(TABS_DIR)
      .filter((f) => f.endsWith('-tab.tsx') && !f.endsWith('.test.tsx'))
      .sort();
    const classified = [...FORM_TABS, ...TABLE_TABS, ...DELEGATING_TABS].sort();
    expect(onDisk).toEqual(classified);
  });

  test('only two widths are in use across the whole panel', () => {
    const widths = new Set(
      [...FORM_TABS, ...TABLE_TABS].map((f) => firstContainerWidth(f)).filter(Boolean),
    );
    expect([...widths].sort()).toEqual(['max-w-2xl', 'max-w-4xl']);
  });
});
