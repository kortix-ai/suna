import { describe, expect, test } from 'bun:test';

import { CUSTOMIZE_SECTION_ACCESS, isCustomizeSectionVisible } from '@/lib/project-actions';

import {
  ALL_PROJECT_SETTINGS_SECTIONS,
  DEFAULT_PROJECT_SETTINGS_SECTION,
  parseProjectSettingsSection,
  projectSettingsSection,
  projectSettingsSectionHref,
  projectSettingsSections,
} from './project-settings-sections';

const keys = () => projectSettingsSections().map((s) => s.key);

/**
 * The sections of `/projects/[id]/customize/settings` — the Customize bar's Settings
 * tab. None is flag-gated. They arrived here from the settings
 * overlay's `Workspace` and `Agent` rail groups, plus its pinned Upgrades row
 * and its `experimental` row; `rail.test.ts` pins that they left there.
 * Models, Channels, Secrets, and Members graduated a SECOND time onto their
 * own top-level Customize tabs and are not here — see
 * `capability-tab-routes.test.ts`. Repositories merged INTO General, under a
 * "Git repo" section — it never had its own top-level concept either.
 * Marketplace was removed from the product outright, not relocated — there is
 * no flag or section for it any more.
 */
describe('projectSettingsSections', () => {
  test('it holds every section, in order', () => {
    expect(keys()).toEqual(['general', 'git', 'sandbox', 'feature-flags', 'upgrades']);
  });

  test('Review is not a section — it is a capability tab', () => {
    expect(keys()).not.toContain('review');
  });

  test('Upgrades is last, where the rail pinned it', () => {
    const all = keys();
    expect(all[all.length - 1]).toBe('upgrades');
  });

  test('no section appears twice', () => {
    const all = keys();
    expect(new Set(all).size).toBe(all.length);
  });

  test('every section carries a label, an icon and a real IAM gate', () => {
    for (const section of ALL_PROJECT_SETTINGS_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.icon).toBeDefined();
      expect(CUSTOMIZE_SECTION_ACCESS[section.gate]).toBeDefined();
    }
  });

  test('the gate is a visibility gate, not a write gate — a caller with the read leaf sees the section', () => {
    for (const section of ALL_PROJECT_SETTINGS_SECTIONS) {
      const read = CUSTOMIZE_SECTION_ACCESS[section.gate].read;
      expect(isCustomizeSectionVisible(section.gate, (action) => action === read)).toBe(true);
      expect(isCustomizeSectionVisible(section.gate, () => false)).toBe(false);
    }
  });

  test('the Experimental tab is called Feature flags here, and keys on the id it already gated on', () => {
    const section = projectSettingsSection('feature-flags');
    expect(section?.label).toBe('Feature flags');
    expect(section?.gate).toBe('feature-flags');
    expect(parseProjectSettingsSection('experimental')).toBeNull();
  });

  test('Upgrades is the agent-driven upgrade runner, not billing', () => {
    // The name is the trap: it opens a change request against this
    // workspace's own repo. Its one description says so, and nothing else in
    // the app says it.
    expect(projectSettingsSection('upgrades')?.description).toContain('change request');
  });

  test('Sandbox templates and Snapshots merged into one section', () => {
    expect(parseProjectSettingsSection('snapshots')).toBeNull();
    expect(projectSettingsSection('sandbox')?.label).toBe('Sandbox templates');
  });

  test('Marketplace is gone, not merely hidden', () => {
    expect(keys()).not.toContain('marketplace');
    expect(parseProjectSettingsSection('marketplace')).toBeNull();
  });

  test('Models, Channels, Secrets, and Members are not sections here — they graduated to their own tabs', () => {
    const all = keys();
    expect(all).not.toContain('models');
    expect(all).not.toContain('channels');
    expect(all).not.toContain('secrets');
    expect(all).not.toContain('members');
  });

  test('Repositories is not a section here — it merged into General', () => {
    expect(keys()).not.toContain('repositories');
    expect(parseProjectSettingsSection('repositories')).toBeNull();
  });
});

describe('parseProjectSettingsSection', () => {
  test('accepts every live key', () => {
    for (const section of ALL_PROJECT_SETTINGS_SECTIONS) {
      expect(parseProjectSettingsSection(section.key)).toBe(section.key);
    }
  });

  test('rejects anything else, so a tampered query lands on the default', () => {
    expect(parseProjectSettingsSection('nope')).toBeNull();
    expect(parseProjectSettingsSection('')).toBeNull();
    expect(parseProjectSettingsSection(null)).toBeNull();
    expect(parseProjectSettingsSection(undefined)).toBeNull();
    // Not fooled by an inherited Object.prototype key.
    expect(parseProjectSettingsSection('constructor')).toBeNull();
  });
});

describe('projectSettingsSectionHref', () => {
  test('the default section carries no query, so /config is a stable link', () => {
    expect(projectSettingsSectionHref('p1', DEFAULT_PROJECT_SETTINGS_SECTION)).toBe(
      '/projects/p1/customize/settings',
    );
  });

  test('every other section names itself in the query', () => {
    expect(projectSettingsSectionHref('p1', 'sandbox')).toBe('/projects/p1/customize/settings?section=sandbox');
    expect(projectSettingsSectionHref('p1', 'feature-flags')).toBe(
      '/projects/p1/customize/settings?section=feature-flags',
    );
  });

  test('the default is always a section, so the page always has a landing section', () => {
    expect(keys()).toContain(DEFAULT_PROJECT_SETTINGS_SECTION);
  });
});

// The retired `/settings/<tab>` URLs redirect to the Settings OVERLAY's
// Workspace group since 2026-09-02 (`settings-tabs.ts`), not to this page —
// both hold the same sections, and the overlay is the one a keyboard reaches.
// This page came back on 2026-09-03 as the Customize bar's Settings tab; the
// redirect target is a separate decision and is pinned in settings-tabs'
// own tests.

/**
 * The sub-nav is ONE flat list. It used to fold these rows into three rail
 * headings (`Workspace` / `Agent` / `Advanced`) via a
 * `groupProjectSettingsSections()` helper; Jay removed the categories on
 * 2026-08-17 ("you don't need the categories … make sure it's just a regular
 * settings thing"), and the helper, the `group` field, and the
 * `ProjectSettingsGroupLabel` union went with them. These cases fail if any of
 * it comes back.
 */
describe('the sub-nav is flat', () => {
  test('no section carries a group heading any more', () => {
    for (const section of ALL_PROJECT_SETTINGS_SECTIONS) {
      expect('group' in section).toBe(false);
    }
  });

  test('the list order IS the rail order — one pass, nothing re-sorted', () => {
    expect(projectSettingsSections().map((s) => s.key)).toEqual(['general', 'git', 'sandbox',
      'feature-flags',
      'upgrades',
    ]);
  });
});
