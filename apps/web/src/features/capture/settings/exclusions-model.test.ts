import { describe, expect, test } from 'bun:test';

import type { CapturePolicy } from '@kortix/sdk';

import { applyToPrivacy, exclusionLists, fromPolicy, includedView } from './exclusions-model';

const LABEL = (id: string) => ({ name: `name:${id}`, description: `hint:${id}` });

const PRIVACY: CapturePolicy['privacy'] = {
  redact_pii: false,
  excluded_bundle_ids: ['com.example.hr'],
  excluded_domains: ['payroll.example'],
  exclusion_groups: ['password_managers'],
  exclude_private_browsing: true,
};

describe('the organization policy', () => {
  test('every category and the mandatory lists, nothing locked', () => {
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

  test('record only included: the switch and both lists, added and removed', () => {
    expect(includedView(PRIVACY)).toEqual({ on: false, apps: [], domains: [] });
    const on = applyToPrivacy(PRIVACY, { kind: 'record-only', on: true });
    const withApp = applyToPrivacy(on, {
      kind: 'include-app',
      id: 'com.tinyspeck.slackmacgap',
      on: true,
    });
    const withSite = applyToPrivacy(withApp, {
      kind: 'include-domain',
      id: 'github.com',
      on: true,
    });
    expect(includedView(withSite)).toEqual({
      on: true,
      apps: [{ id: 'com.tinyspeck.slackmacgap', name: 'com.tinyspeck.slackmacgap', locked: false }],
      domains: [{ id: 'github.com', name: 'github.com', locked: false }],
    });
    expect(
      applyToPrivacy(withSite, { kind: 'include-domain', id: 'github.com', on: false })
        .included_domains,
    ).toEqual([]);
    expect(PRIVACY.record_only_included).toBeUndefined();
  });
});
