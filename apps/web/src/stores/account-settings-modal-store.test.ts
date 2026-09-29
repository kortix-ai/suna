import { afterEach, expect, mock, test } from 'bun:test';

const openAccountPanel = mock(() => {});
const hubTarget = mock((accountId: string | null, opts?: { tab?: string }) => ({ accountId, ...opts }));
const getState = mock(() => ({ selectedAccountId: 'synthetic-account' }));

mock.module('@/stores/account-panel-store', () => ({ openAccountPanel, hubTarget }));
mock.module('@/stores/current-account-store', () => ({ useCurrentAccountStore: { getState } }));

const settings = await import('./account-settings-modal-store');
const { accountSettingsTarget, openAccountSettings } = settings;

afterEach(() => {
  openAccountPanel.mockClear();
  hubTarget.mockClear();
  getState.mockClear();
});

test('opens the selected account billing tab without putting highlight in the URL', () => {
  openAccountSettings({ tab: 'transactions', highlight: 'credits' });
  expect(openAccountPanel).toHaveBeenCalledWith({ accountId: 'synthetic-account', tab: 'transactions' });
  expect(hubTarget).toHaveBeenCalledWith('synthetic-account', { tab: 'transactions' });
});

test('defaults to billing and sends an unselected account to the hub list', () => {
  expect(accountSettingsTarget({ accountId: null })).toEqual({ accountId: null });
  openAccountSettings();
  expect(openAccountPanel).toHaveBeenCalledWith({ accountId: 'synthetic-account', tab: 'billing' });
});
