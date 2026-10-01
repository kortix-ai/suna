import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let segment = 'connected';
let pending = false;
let failed = false;
let accounts: { account_id: string }[] = [];
let retries = 0;
const replacements: string[] = [];
mock.module('next/navigation', () => ({
  useParams: () => ({ tab: segment }),
  useRouter: () => ({ replace: (href: string) => replacements.push(href) }),
}));
mock.module('@/hooks/account/use-ensure-selected-account', () => ({
  useEnsureSelectedAccount: () => {},
}));
mock.module('@/features/workspace/settings/use-settings-account-id', () => ({
  useSettingsAccountId: () => 'stale-account',
}));
mock.module('@/hooks/account/use-accounts-list', () => ({
  useAccountsList: () => ({
    data: accounts,
    isPending: pending,
    isError: failed,
    refetch: () => {
      retries += 1;
    },
  }),
}));
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => (key: string) => key }));
mock.module('@/features/workspace/settings/standalone-settings-route', () => ({
  STANDALONE_DEFAULT_SETTINGS_TAB: 'profile',
  StandaloneSettingsRoute: ({ tab }: { tab: string }) => createElement('main', null, tab),
}));
mock.module('@/features/layout/section/error-state', () => ({
  ErrorState: ({ title, action }: { title: string; action: React.ReactNode }) =>
    createElement('section', null, title, action),
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) =>
    createElement('button', { onClick }, children),
}));
mock.module('@/components/common/route-loading', () => ({
  RouteLoadingFallback: () => createElement('p', null, 'Loading'),
}));
const { default: SettingsTabPage } = await import('./page');

test('connected waits for accounts, then opens the real account Git destination', async () => {
  segment = 'connected';
  pending = true;
  failed = false;
  accounts = [];
  replacements.length = 0;
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(createElement(SettingsTabPage));
  });
  if (!root) throw new Error('Settings route did not render');
  expect(JSON.stringify(root.toJSON())).toContain('Loading');
  expect(JSON.stringify(root.toJSON())).not.toContain('profile');
  expect(replacements).toEqual([]);
  pending = false;
  accounts = [{ account_id: 'synthetic' }];
  await act(async () => {
    root?.update(createElement(SettingsTabPage));
  });
  expect(replacements).toEqual(['/projects?accountId=synthetic&accountTab=git']);
  expect(JSON.stringify(root.toJSON())).not.toContain('profile');
  await act(async () => {
    root?.unmount();
  });
});

test('failed or empty account lookup shows a retryable error, never Profile', async () => {
  segment = 'connected';
  pending = false;
  retries = 0;
  for (const error of [true, false]) {
    failed = error;
    accounts = [];
    replacements.length = 0;
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(SettingsTabPage));
    });
    if (!root) throw new Error('Settings route did not render');
    expect(JSON.stringify(root.toJSON())).toContain('error');
    expect(JSON.stringify(root.toJSON())).not.toContain('profile');
    expect(replacements).toEqual([]);
    await act(async () => {
      root?.root.findByType('button').props.onClick();
    });
    await act(async () => {
      root?.unmount();
    });
  }
  expect(retries).toBe(2);
});

test('live, unknown and project-only segments keep existing standalone behavior', async () => {
  accounts = [];
  pending = false;
  failed = false;
  for (const [raw, expected] of [
    ['security', 'security'],
    ['unknown', 'profile'],
    ['secrets', 'profile'],
    ['api-keys', 'profile'],
  ]) {
    segment = raw;
    replacements.length = 0;
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(SettingsTabPage));
    });
    if (!root) throw new Error('Settings route did not render');
    expect(JSON.stringify(root.toJSON())).toContain(expected);
    expect(replacements).toEqual([]);
    await act(async () => {
      root?.unmount();
    });
  }
});
