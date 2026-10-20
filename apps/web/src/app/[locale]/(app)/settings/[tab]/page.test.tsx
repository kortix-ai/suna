import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let segment = 'connected';
let pending = false;
let failed = false;
let accounts: { account_id: string }[] = [];
let retries = 0;
let authLoading = false;
let lastProjectId: string | null = null;
const lastProjectReads: (string | null | undefined)[] = [];
const replacements: string[] = [];
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: authLoading ? null : { id: 'synthetic-user' }, isLoading: authLoading }),
}));
mock.module('@/lib/onboarding/last-project-cookie', () => ({
  readLastProjectId: (userId: string | null | undefined) => {
    lastProjectReads.push(userId);
    return userId === 'synthetic-user' ? lastProjectId : null;
  },
}));
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
const uiButtonMock = () => ({
  Button: ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) =>
    createElement('button', { onClick }, children),
});
mock.module('@/components/ui/button', uiButtonMock);
mock.module('@kortix/ui/button', uiButtonMock);
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

test('live, renamed, unknown and project-only segments open their standalone tab', async () => {
  accounts = [];
  pending = false;
  failed = false;
  for (const [raw, expected] of [
    ['security', 'security'],
    // KRTX-2291: the old personal API keys tab is `tokens` now (`RENAMED`).
    ['api-keys', 'tokens'],
    ['tokens', 'tokens'],
    ['unknown', 'profile'],
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

// KRTX-2865: a stale `/settings/computers` link rendered Profile under a
// computers URL. A segment that needs a project opens in the project this
// browser had open last, and in the project list when it remembers none.
test('a segment that needs a project opens in the last project, never Profile', async () => {
  accounts = [];
  pending = false;
  failed = false;
  for (const [raw, remembered, expected] of [
    ['computers', 'p1', '/projects/p1/customize/connectors'],
    ['computer', 'p1', '/projects/p1/settings/computer'],
    ['secrets', 'p1', '/projects/p1/customize/secrets'],
    ['computers', null, '/projects'],
  ] as const) {
    segment = raw;
    lastProjectId = remembered;
    replacements.length = 0;
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(SettingsTabPage));
    });
    if (!root) throw new Error('Settings route did not render');
    expect(replacements).toEqual([expected]);
    expect(JSON.stringify(root.toJSON())).not.toContain('profile');
    await act(async () => {
      root?.unmount();
    });
  }
});

test('a project segment waits for the signed-in user before it reads the last project', async () => {
  accounts = [];
  pending = false;
  failed = false;
  segment = 'computers';
  lastProjectId = 'p1';
  authLoading = true;
  replacements.length = 0;
  lastProjectReads.length = 0;
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(createElement(SettingsTabPage));
  });
  if (!root) throw new Error('Settings route did not render');
  expect(replacements).toEqual([]);
  expect(lastProjectReads).toEqual([]);
  expect(JSON.stringify(root.toJSON())).toContain('Loading');
  authLoading = false;
  await act(async () => {
    root?.update(createElement(SettingsTabPage));
  });
  expect(replacements).toEqual(['/projects/p1/customize/connectors']);
  await act(async () => {
    root?.unmount();
  });
});
