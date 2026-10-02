/**
 * The account-hub deep link over the standalone settings route.
 *
 * The hub is a modal mounted in `(app)/layout.tsx` whose open state IS the
 * `?accountId=` param (`stores/account-panel-store.ts`), and the personal
 * settings panel is another full-screen modal that this route raises on
 * mount. Both live on the z-stack (`lib/z-stack.tsx`), where the dialog that
 * opened later wins — so a hard load of `/settings?accountId=<id>` (a hub
 * deep link: the hub's own address bar URL and its Manage link's href) used
 * to raise the personal panel ON TOP of the already-open hub, and the user
 * saw Profile instead of the hub.
 *
 * This component cannot render its real panel under `react-test-renderer`
 * (`settings-panel.test.tsx`'s header), so `SettingsPanel` is mocked and the
 * observable is the store the route drives: which surface the route decides
 * to raise, and when.
 */

import { beforeEach, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/** The URL query `useSearchParams` answers with; rewritten per scenario. */
let search = '';
const replacements: string[] = [];

mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: (href: string) => replacements.push(href) }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(search),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'synthetic-user' } }),
}));
mock.module('@/hooks/account/use-ensure-selected-account', () => ({
  useEnsureSelectedAccount: () => {},
}));
// The route's decision is what this file pins; the panel rendering it is
// `settings-panel.test.tsx`'s subject, and its body cannot mount here.
mock.module('./settings-panel', () => ({ SettingsPanel: () => null }));
mock.module('@/lib/onboarding/last-project-cookie', () => ({
  readLastProjectId: () => null,
}));

const { StandaloneSettingsRoute } = await import('./standalone-settings-route');
const { useSettingsPanelStore } = await import('@/stores/settings-panel-store');

type StandaloneTab = Parameters<typeof StandaloneSettingsRoute>[0]['tab'];

function mount(tab: StandaloneTab) {
  let root: ReturnType<typeof create> | undefined;
  return {
    async open() {
      await act(async () => {
        root = create(createElement(StandaloneSettingsRoute, { tab }));
      });
      if (!root) throw new Error('route did not render');
      return root;
    },
  };
}

beforeEach(() => {
  search = '';
  replacements.length = 0;
  useSettingsPanelStore.setState({ open: false });
});

test('a hard-loaded hub deep link does not raise the personal panel over the hub', async () => {
  search = 'accountId=acc_1&accountTab=members';
  const { open } = mount('profile');
  const root = await open();
  expect(useSettingsPanelStore.getState().open).toBe(false);
  // `?accountId=` with no value is the hub's account-list pane — still open.
  search = 'accountId=';
  await act(async () => {
    root.update(createElement(StandaloneSettingsRoute, { tab: 'profile' }));
  });
  expect(useSettingsPanelStore.getState().open).toBe(false);
  await act(async () => {
    root.unmount();
  });
});

test('the bare /settings load still raises the personal panel', async () => {
  const { open } = mount('profile');
  const root = await open();
  expect(useSettingsPanelStore.getState().open).toBe(true);
  expect(useSettingsPanelStore.getState().tab).toBe('profile');
  await act(async () => {
    root.unmount();
  });
});

test('closing the hub hands the page back to the personal panel', async () => {
  search = 'accountId=acc_1&accountTab=members';
  const { open } = mount('profile');
  const root = await open();
  expect(useSettingsPanelStore.getState().open).toBe(false);
  // The hub closes by dropping the param from the URL.
  search = '';
  await act(async () => {
    root.update(createElement(StandaloneSettingsRoute, { tab: 'profile' }));
  });
  expect(useSettingsPanelStore.getState().open).toBe(true);
  expect(useSettingsPanelStore.getState().tab).toBe('profile');
  await act(async () => {
    root.unmount();
  });
});

test('a hub opened over an open panel leaves it open, on its own tab', async () => {
  const { open } = mount('profile');
  const root = await open();
  expect(useSettingsPanelStore.getState().open).toBe(true);
  // The user moves the panel to another tab before opening the hub.
  act(() => {
    useSettingsPanelStore.getState().setTab('security');
  });
  search = 'accountId=acc_1';
  await act(async () => {
    root.update(createElement(StandaloneSettingsRoute, { tab: 'profile' }));
  });
  expect(useSettingsPanelStore.getState().open).toBe(true);
  // Closing the hub must not re-raise the panel at the route's default tab.
  search = '';
  await act(async () => {
    root.update(createElement(StandaloneSettingsRoute, { tab: 'profile' }));
  });
  expect(useSettingsPanelStore.getState().open).toBe(true);
  expect(useSettingsPanelStore.getState().tab).toBe('security');
  await act(async () => {
    root.unmount();
  });
});

test('explicit route tabs override an existing selection and follow navigation', async () => {
  useSettingsPanelStore.setState({ open: true, tab: 'security' });
  const root = await mount('profile').open();
  expect(useSettingsPanelStore.getState().tab).toBe('profile');
  await act(async () => {
    root.update(createElement(StandaloneSettingsRoute, { tab: 'security' }));
  });
  expect(useSettingsPanelStore.getState().tab).toBe('security');
  await act(async () => {
    useSettingsPanelStore.getState().close();
  });
  expect(replacements).toEqual(['/projects']);
  await act(async () => { root.unmount(); });
});
