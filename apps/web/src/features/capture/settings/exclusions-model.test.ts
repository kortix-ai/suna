import { describe, expect, test } from 'bun:test';

import type { DesktopCaptureExclusions } from '@/lib/desktop';

import type { CapturePolicy } from '@kortix/sdk';

import {
  applyExclusion,
  applyToPrivacy,
  exclusionLists,
  fromEngine,
  fromPolicy,
} from './exclusions-model';

const DATA: DesktopCaptureExclusions = {
  groups: [
    {
      id: 'password_managers',
      name: 'Password managers',
      description: 'Password manager apps',
      apps: 9,
      domains: 4,
      enabled: true,
      by_org: false,
    },
    {
      id: 'messaging',
      name: 'Messaging apps',
      description: 'Chat apps',
      apps: 6,
      domains: 0,
      enabled: false,
      by_org: false,
    },
    {
      id: 'banking',
      name: 'Banking and finance',
      description: 'Banks and fintech',
      apps: 23,
      domains: 952,
      enabled: true,
      by_org: true,
    },
  ],
  excluded_apps: [
    { bundle_id: 'com.example.vault', name: 'Vault', by_org: false },
    { bundle_id: 'com.example.hr', name: 'HR Portal', by_org: true },
  ],
  excluded_domains: [{ domain: 'payroll.example', by_org: false }],
  private_browsing: { excluded: true, by_org: false },
  recent_apps: [
    { bundle_id: 'com.example.notes', name: 'Notes', last_seen_ms: 3, excluded: false },
    { bundle_id: 'com.example.vault', name: 'Vault', last_seen_ms: 2, excluded: true },
    { bundle_id: 'com.example.mail', name: 'Mail', last_seen_ms: 1, excluded: false },
  ],
  recent_domains: [
    { domain: 'docs.example', last_seen_ms: 2, excluded: false },
    { domain: 'payroll.example', last_seen_ms: 1, excluded: true },
  ],
  frontmost: null,
};

const LABEL = (id: string) => ({ name: `name:${id}`, description: `hint:${id}` });

const PRIVACY: CapturePolicy['privacy'] = {
  redact_pii: false,
  excluded_bundle_ids: ['com.example.hr'],
  excluded_domains: ['payroll.example'],
  exclusion_groups: ['password_managers'],
  exclude_private_browsing: true,
};

describe('exclusionLists (device mode, from the engine)', () => {
  test('apps: categories with apps, the excluded apps, and recently recorded apps that are not excluded', () => {
    const lists = exclusionLists(fromEngine(DATA), 'apps', '');
    expect(lists.categories.map((g) => g.id)).toEqual([
      'password_managers',
      'messaging',
      'banking',
    ]);
    expect(lists.excluded.map((row) => row.id)).toEqual(['com.example.vault', 'com.example.hr']);
    expect(lists.recent.map((row) => row.id)).toEqual(['com.example.notes', 'com.example.mail']);
  });

  test('websites: only categories with domains; recently recorded sites that are not excluded', () => {
    const lists = exclusionLists(fromEngine(DATA), 'websites', '');
    expect(lists.categories.map((g) => g.id)).toEqual(['password_managers', 'banking']);
    expect(lists.excluded.map((row) => row.id)).toEqual(['payroll.example']);
    expect(lists.recent.map((row) => row.id)).toEqual(['docs.example']);
  });

  test('the search narrows every list, case-insensitive, by name or id', () => {
    const lists = exclusionLists(fromEngine(DATA), 'apps', 'MAIL');
    expect(lists.categories).toEqual([]);
    expect(lists.excluded).toEqual([]);
    expect(lists.recent.map((row) => row.id)).toEqual(['com.example.mail']);
    expect(
      exclusionLists(fromEngine(DATA), 'apps', 'com.example.hr').excluded.map((row) => row.id),
    ).toEqual(['com.example.hr']);
  });

  test('what the organization set is locked', () => {
    const view = fromEngine(DATA);
    expect(
      exclusionLists(view, 'apps', '').excluded.find((row) => row.id === 'com.example.hr')?.locked,
    ).toBe(true);
    expect(view.groups.find((group) => group.id === 'banking')?.locked).toBe(true);
    expect(view.privateBrowsing).toEqual({ excluded: true, locked: false });
  });
});

describe('org mode, from the policy', () => {
  test('every category, the mandatory lists, nothing locked and nothing recent', () => {
    const view = fromPolicy(PRIVACY, LABEL);
    expect(view.groups.map((group) => [group.id, group.enabled, group.locked])).toEqual([
      ['password_managers', true, false],
      ['messaging', false, false],
      ['banking', false, false],
    ]);
    expect(view.groups[0]?.name).toBe('name:password_managers');
    const apps = exclusionLists(view, 'apps', '');
    expect(apps.categories).toHaveLength(3);
    expect(apps.excluded).toEqual([
      { id: 'com.example.hr', name: 'com.example.hr', locked: false },
    ]);
    expect(apps.recent).toEqual([]);
    expect(exclusionLists(view, 'websites', '').excluded.map((row) => row.id)).toEqual([
      'payroll.example',
    ]);
    expect(view.privateBrowsing).toEqual({ excluded: true, locked: false });
  });

  test('applyToPrivacy adds and removes each kind without duplicates or mutation', () => {
    const added = applyToPrivacy(PRIVACY, { kind: 'app', id: 'com.example.vault', on: true });
    expect(added.excluded_bundle_ids).toEqual(['com.example.hr', 'com.example.vault']);
    expect(
      applyToPrivacy(added, { kind: 'app', id: 'com.example.vault', on: true }).excluded_bundle_ids,
    ).toHaveLength(2);
    expect(
      applyToPrivacy(PRIVACY, { kind: 'app', id: 'com.example.hr', on: false }).excluded_bundle_ids,
    ).toEqual([]);
    expect(
      applyToPrivacy(PRIVACY, { kind: 'domain', id: 'bank.example', on: true }).excluded_domains,
    ).toEqual(['payroll.example', 'bank.example']);
    expect(
      applyToPrivacy(PRIVACY, { kind: 'group', id: 'banking', on: true }).exclusion_groups,
    ).toEqual(['password_managers', 'banking']);
    expect(
      applyToPrivacy(PRIVACY, { kind: 'group', id: 'password_managers', on: false })
        .exclusion_groups,
    ).toEqual([]);
    expect(
      applyToPrivacy(PRIVACY, { kind: 'private-browsing', on: false }).exclude_private_browsing,
    ).toBe(false);
    expect(PRIVACY.excluded_bundle_ids).toEqual(['com.example.hr']);
  });
});

describe('applyExclusion (the optimistic update)', () => {
  test('excluding a recent app moves it to Excluded; including it moves it back', () => {
    const excluded = applyExclusion(DATA, { kind: 'app', id: 'com.example.notes', on: true });
    expect(excluded.excluded_apps.map((a) => a.bundle_id)).toContain('com.example.notes');
    expect(excluded.excluded_apps.find((a) => a.bundle_id === 'com.example.notes')?.name).toBe(
      'Notes',
    );
    expect(excluded.recent_apps.find((a) => a.bundle_id === 'com.example.notes')?.excluded).toBe(
      true,
    );
    const included = applyExclusion(excluded, { kind: 'app', id: 'com.example.notes', on: false });
    expect(included.excluded_apps.map((a) => a.bundle_id)).not.toContain('com.example.notes');
    expect(included.recent_apps.find((a) => a.bundle_id === 'com.example.notes')?.excluded).toBe(
      false,
    );
  });

  test('a domain, a category and private browsing flip in place; the input is not mutated', () => {
    const next = applyExclusion(DATA, { kind: 'domain', id: 'docs.example', on: true });
    expect(next.excluded_domains.map((d) => d.domain)).toEqual(['payroll.example', 'docs.example']);
    expect(DATA.excluded_domains).toHaveLength(1);
    expect(
      applyExclusion(DATA, { kind: 'group', id: 'messaging', on: true }).groups[1]?.enabled,
    ).toBe(true);
    expect(
      applyExclusion(DATA, { kind: 'private-browsing', on: false }).private_browsing.excluded,
    ).toBe(false);
  });

  test('a domain already excluded is not listed twice', () => {
    const next = applyExclusion(DATA, { kind: 'domain', id: 'payroll.example', on: true });
    expect(next.excluded_domains).toHaveLength(1);
  });
});
