/**
 * The Account page's Preferences group carries the Rich answers switch, bound
 * to the persisted genui store. Hooks, primitives, and the settings list are
 * host stubs, so the assertions read the row and the switch it renders.
 * Run with `bun test --isolate`.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useGenuiStore } from '@/stores/genui-store';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

mock.module('react-native', () => ({ View: host('view'), Pressable: host('pressable') }));
mock.module('expo-router', () => ({ useRouter: () => ({ push: none, replace: none }) }));
mock.module('expo-constants', () => ({ default: { expoConfig: { version: '0.0.0' } } }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/lib/icons', () => ({
  BellIcon: none,
  BookOpenIcon: none,
  CaretRightIcon: none,
  GlobeIcon: none,
  LifebuoyIcon: none,
  SignOutIcon: none,
  SpeakerHighIcon: none,
  SquaresFourIcon: none,
}));
mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: none,
  AlertDialogCancel: none,
  AlertDialogContent: none,
  AlertDialogDescription: none,
  AlertDialogFooter: none,
  AlertDialogHeader: none,
  AlertDialogTitle: none,
}));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/switch', () => ({ Switch: host('switch') }));
mock.module('@/components/kortix/avatar', () => ({ Avatar: none }));
mock.module('@/components/kortix/KortixLogo', () => ({ KortixLogo: none }));
mock.module('@/components/kortix/settings-list', () => ({
  AppearanceRow: none,
  SettingsGroup: host('settings-group'),
  SettingsHeader: none,
  SettingsPage: host('settings-page'),
  SettingsRow: host('settings-row'),
}));
mock.module('@/components/billing/PricingTierBadge', () => ({ PricingTierBadge: none }));
mock.module('@/components/settings/EditProfileSheet', () => ({ EditProfileSheet: none }));
mock.module('@/components/settings/ProfilePicture', () => ({ ProfilePicture: none }));
mock.module('@/lib/kortix-web', () => ({ KORTIX_WEB_URL: 'https://example.com' }));
mock.module('@/contexts', () => ({
  useAuthContext: () => ({ user: null, signOut: async () => ({ success: true }), isSigningOut: false }),
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    currentLanguage: 'en',
    availableLanguages: [],
  }),
}));
mock.module('@/hooks/useAccountDeletion', () => ({ useAccountDeletionStatus: () => ({ data: undefined }) }));
mock.module('@/hooks/useActiveAccount', () => ({ useActiveAccount: () => ({ account: null }) }));
mock.module('@/hooks/useProfileEditor', () => ({
  useProfileEditor: () => ({ avatarUrl: null, displayName: 'Test User', email: 'user@example.com' }),
}));
mock.module('@/hooks/useActivePlanName', () => ({ useActivePlanName: () => null }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: none, warning: none, medium: none, success: none } }));
mock.module('@/lib/utils/open-link', () => ({ openLink: async () => {} }));
mock.module('@/lib/utils/locale-config', () => ({ LANGUAGE_PICKER_ENABLED: false }));

let AccountPage: typeof import('./AccountPage').AccountPage;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ AccountPage } = await import('./AccountPage'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  useGenuiStore.getState().setEnabled(true);
});

type SwitchProps = { checked: boolean; onCheckedChange: (on: boolean) => void };
/** The Rich answers row's trailing switch, as the row receives it. */
const richAnswersSwitch = (): SwitchProps =>
  (tree!.root.findByProps({ label: 'Rich answers' }).props.right as React.ReactElement<SwitchProps>).props;

describe('AccountPage Rich answers', () => {
  test('the row has no description and its switch reflects and toggles the store', () => {
    act(() => {
      tree = create(<AccountPage presentation="project" />);
    });
    const row = tree!.root.findByProps({ label: 'Rich answers' });
    expect(row.props.description).toBeUndefined();
    expect(richAnswersSwitch().checked).toBe(true);

    act(() => {
      richAnswersSwitch().onCheckedChange(false);
    });
    expect(useGenuiStore.getState().enabled).toBe(false);
    expect(richAnswersSwitch().checked).toBe(false);

    act(() => {
      richAnswersSwitch().onCheckedChange(true);
    });
    expect(useGenuiStore.getState().enabled).toBe(true);
  });
});
