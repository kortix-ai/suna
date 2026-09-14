// The hub's breadcrumb and its section parsing are pure functions of the hub's
// state. Pinned here so a new place inside the hub has to say what its crumb
// is, and so the legacy `?tab=overview` fold and the "unknown tab is not a
// section" rule survive.
//
// The crumbs take no URL: the hub has no route, only `?accountId=` on the page
// it floats over, so each crumb names a `HubTarget` that `HubLink` turns into
// a real href for whatever page that is.
import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';
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
  const root = { label: 'Settings', to: { accountId: '', params: {} } };
  const account = {
    label: 'Acme',
    to: { accountId: id, params: {} },
    kind: 'account',
  };

  test('with no account chosen it is Settings / Accounts', () => {
    expect(
      accountHubCrumbs({ accountId: undefined, activeSection: 'members' }, testUiTranslator),
    ).toEqual([root, { label: 'Accounts' }]);
  });

  test('the hub is Settings / <account> / <resolved section>, never the requested one', () => {
    expect(
      accountHubCrumbs(
        { accountId: id, activeSection: 'access-projects', accountName: 'Acme' },
        testUiTranslator,
      ),
    ).toEqual([root, account, { label: 'Projects' }]);
  });

  test('the account crumb is pending until the record has loaded', () => {
    expect(
      accountHubCrumbs({ accountId: id, activeSection: 'members' }, testUiTranslator)[1],
    ).toEqual({
      label: 'Account',
      to: { accountId: id, params: {} },
      pending: true,
      kind: 'account',
    });
    expect(
      accountHubCrumbs(
        { accountId: id, activeSection: 'members', accountName: '' },
        testUiTranslator,
      )[1]?.pending,
    ).toBe(true);
  });

  test('a guided wizard hangs off Identity, and its third crumb goes back there', () => {
    expect(
      accountHubCrumbs(
        { accountId: id, activeSection: 'identity', setup: 'sso', accountName: 'Acme' },
        testUiTranslator,
      ),
    ).toEqual([
      root,
      account,
      { label: 'Identity', to: { accountId: id, params: { tab: 'identity' } } },
      { label: 'SSO setup' },
    ]);
    expect(
      accountHubCrumbs(
        { accountId: id, activeSection: 'identity', setup: 'scim', accountName: 'Acme' },
        testUiTranslator,
      )[3],
    ).toEqual({ label: 'Directory sync setup' });
  });

  test('an unknown setup value is ignored, not rendered as a crumb', () => {
    expect(
      accountHubCrumbs(
        { accountId: id, activeSection: 'members', setup: 'nonsense', accountName: 'Acme' },
        testUiTranslator,
      ),
    ).toEqual([root, account, { label: 'Members' }]);
  });

  test('the last crumb is never a link — where you are is not a destination', () => {
    for (const input of [
      { accountId: undefined, activeSection: 'members' as const },
      { accountId: id, activeSection: 'billing' as const, accountName: 'Acme' },
      { accountId: id, activeSection: 'identity' as const, setup: 'sso', accountName: 'Acme' },
    ]) {
      const crumbs = accountHubCrumbs(input, testUiTranslator);
      expect(crumbs[crumbs.length - 1]!.to).toBeUndefined();
    }
  });
});
