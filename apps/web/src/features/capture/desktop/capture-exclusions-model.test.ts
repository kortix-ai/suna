import { describe, expect, test } from 'bun:test';

import type { DesktopCaptureExclusions } from '@/lib/desktop';

import { applyExclusion, exclusionLists, normalizeDomain } from './capture-exclusions-model';

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

describe('exclusionLists', () => {
  test('apps: categories with apps, the excluded apps, and recently recorded apps that are not excluded', () => {
    const lists = exclusionLists(DATA, 'apps', '');
    expect(lists.categories.map((g) => g.id)).toEqual([
      'password_managers',
      'messaging',
      'banking',
    ]);
    expect(lists.excluded.map((row) => row.id)).toEqual(['com.example.vault', 'com.example.hr']);
    expect(lists.recent.map((row) => row.id)).toEqual(['com.example.notes', 'com.example.mail']);
  });

  test('websites: only categories with domains; recently recorded sites that are not excluded', () => {
    const lists = exclusionLists(DATA, 'websites', '');
    expect(lists.categories.map((g) => g.id)).toEqual(['password_managers', 'banking']);
    expect(lists.excluded.map((row) => row.id)).toEqual(['payroll.example']);
    expect(lists.recent.map((row) => row.id)).toEqual(['docs.example']);
  });

  test('the search narrows every list, case-insensitive, by name or id', () => {
    const lists = exclusionLists(DATA, 'apps', 'MAIL');
    expect(lists.categories).toEqual([]);
    expect(lists.excluded).toEqual([]);
    expect(lists.recent.map((row) => row.id)).toEqual(['com.example.mail']);
    expect(exclusionLists(DATA, 'apps', 'com.example.hr').excluded.map((row) => row.id)).toEqual([
      'com.example.hr',
    ]);
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

test('normalizeDomain: what a person types or pastes becomes a domain, or null', () => {
  expect(normalizeDomain('https://www.Example.co.uk/login?x=1')).toBe('example.co.uk');
  expect(normalizeDomain(' mail.example.com:443 ')).toBe('mail.example.com');
  expect(normalizeDomain('localhost')).toBeNull();
  expect(normalizeDomain('two words')).toBeNull();
  expect(normalizeDomain('')).toBeNull();
});
