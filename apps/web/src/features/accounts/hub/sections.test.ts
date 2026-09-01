// The settings shell's breadcrumb and the hub's section parsing are pure
// functions of the URL. Pinned here so a route added under `/accounts/[id]`
// has to say what its crumb is, and so the legacy `?tab=overview` fold and
// the "unknown tab is not a section" rule survive the catalog moving files.
import { describe, expect, test } from 'bun:test';

import {
  NAV_GROUPS,
  PANE_META,
  VALID_TABS,
  accountHubCrumbs,
  paneWidth,
  parseAccountSection,
  sectionLabel,
} from './sections';

describe('parseAccountSection', () => {
  test('every catalog id round-trips', () => {
    for (const tab of VALID_TABS) expect(parseAccountSection(tab)).toBe(tab);
  });

  test('the legacy overview deep link folds into billing', () => {
    expect(parseAccountSection('overview')).toBe('billing');
  });

  test('anything else is not a section', () => {
    expect(parseAccountSection('')).toBeNull();
    expect(parseAccountSection(null)).toBeNull();
    expect(parseAccountSection(undefined)).toBeNull();
    expect(parseAccountSection('Members')).toBeNull();
    expect(parseAccountSection('settings/')).toBeNull();
  });
});

describe('the catalog', () => {
  test('every valid tab appears in exactly one nav group', () => {
    const ids = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect([...ids].sort()).toEqual([...VALID_TABS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every pane title is a nav label — the breadcrumb and the heading agree', () => {
    for (const [section, meta] of Object.entries(PANE_META)) {
      expect(meta.title).toBe(sectionLabel(section as (typeof VALID_TABS)[number]));
    }
  });

  test('the ledger is the only full-width pane', () => {
    expect(paneWidth('transactions')).toBe('full');
    expect(paneWidth('settings')).toBe('default');
    expect(paneWidth('members')).toBe('wide');
  });
});

describe('accountHubCrumbs', () => {
  const id = 'acc_123';
  const root = { label: 'Settings', href: '/accounts' };
  const account = { label: 'Acme', href: `/accounts/${id}`, kind: 'account' };

  test('the account index is Settings / Accounts', () => {
    expect(accountHubCrumbs('/accounts', undefined, 'members')).toEqual([
      { label: 'Settings', href: '/accounts' },
      { label: 'Accounts' },
    ]);
  });

  test('the hub is Settings / <account> / <resolved section>, never the requested one', () => {
    expect(accountHubCrumbs(`/accounts/${id}`, id, 'access-projects', 'Acme')).toEqual([
      root,
      account,
      { label: 'Projects' },
    ]);
  });

  test('the account crumb is pending until the record has loaded', () => {
    expect(accountHubCrumbs(`/accounts/${id}`, id, 'members', undefined)[1]).toEqual({
      label: 'Account',
      href: `/accounts/${id}`,
      pending: true,
      kind: 'account',
    });
    expect(accountHubCrumbs(`/accounts/${id}`, id, 'members', '')[1]?.pending).toBe(true);
  });

  test('the guided-setup routes hang off Identity', () => {
    expect(accountHubCrumbs(`/accounts/${id}/sso-setup`, id, 'members', 'Acme')).toEqual([
      root,
      account,
      { label: 'Identity', href: `/accounts/${id}?tab=identity` },
      { label: 'SSO setup' },
    ]);
    expect(accountHubCrumbs(`/accounts/${id}/scim-setup`, id, 'members', 'Acme')[3]).toEqual({
      label: 'Directory sync setup',
    });
  });

  test('a token detail hangs off Tokens', () => {
    expect(accountHubCrumbs(`/accounts/${id}/tokens/tok_1`, id, 'members', 'Acme')).toEqual([
      root,
      account,
      { label: 'Tokens', href: `/accounts/${id}?tab=tokens` },
      { label: 'Token' },
    ]);
  });

  test('the legacy group and member detail routes name their section', () => {
    expect(accountHubCrumbs(`/accounts/${id}/groups/g1`, id, 'members', 'Acme')[2]).toEqual({
      label: 'Groups',
    });
    expect(accountHubCrumbs(`/accounts/${id}/members/u1`, id, 'members', 'Acme')[2]).toEqual({
      label: 'Members',
    });
  });

  test('the last crumb is never a link', () => {
    for (const path of ['/accounts', `/accounts/${id}`, `/accounts/${id}/sso-setup`]) {
      const crumbs = accountHubCrumbs(
        path,
        path === '/accounts' ? undefined : id,
        'settings',
        'Acme',
      );
      expect(crumbs.at(-1)?.href).toBeUndefined();
    }
  });
});
