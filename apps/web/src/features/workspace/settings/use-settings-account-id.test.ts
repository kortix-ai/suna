import { describe, expect, test } from 'bun:test';

import { resolveSettingsAccountId } from './use-settings-account-id';

// Ported from `connected-tab.test.tsx`'s `describe('resolveConnectedAccountsId', ...)`
// (JAY-497) onto the shared resolver — see this file's header comment for why
// the fallback exists. `useSettingsAccountId` itself (the thin
// `useCurrentAccountStore` wrapper) is intentionally not exercised via
// `renderToStaticMarkup` here: zustand's `persist` middleware returns its
// pre-hydration server snapshot under `renderToStaticMarkup`, independent of
// any `setState` call made in the same test — a live-in-a-browser-only
// behaviour, not something this pure resolver test needs to reach through.
describe('resolveSettingsAccountId', () => {
  test('prefers the project account id when present, even with a different selected account', () => {
    expect(resolveSettingsAccountId('proj-acct', 'store-acct')).toBe('proj-acct');
  });

  test('falls back to the store-selected account id with no project open', () => {
    expect(resolveSettingsAccountId(undefined, 'store-acct')).toBe('store-acct');
  });

  test('resolves to undefined when neither source has a value', () => {
    expect(resolveSettingsAccountId(undefined, null)).toBeUndefined();
    expect(resolveSettingsAccountId(undefined, undefined)).toBeUndefined();
  });
});
