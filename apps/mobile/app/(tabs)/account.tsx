import * as React from 'react';
import { Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Bell,
  BookOpen,
  Globe,
  LifeBuoy,
  LogOut,
  Palette,
  Trash2,
  User,
  Users,
  Volume2,
  Wallet,
} from 'lucide-react-native';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { useAuthContext, useLanguage } from '@/contexts';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/kortix/avatar';
import {
  AppearanceToggle,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import { getFrontendUrl } from '@/api/config';
import { haptics } from '@/lib/haptics';
import { useAccounts } from '@/lib/projects/hooks';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  TAB_SCROLL_INSET_ADJUSTMENT,
  usesNativeTabBar,
  useTabBarClearance,
} from '@/components/navigation/tab-bar-layout';

export default function AccountTab() {
  const { user, signOut, isSigningOut } = useAuthContext();
  const { t, currentLanguage, availableLanguages } = useLanguage();
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const insets = useSafeAreaInsets();
  // No screen header on this tab. iOS scroll views inset the status bar
  // themselves (contentInsetAdjustmentBehavior="automatic"); the Android
  // floating tab bar screens pad for it here.
  const profileTopPadding = usesNativeTabBar ? 12 : insets.top + 16;

  const accountsQuery = useAccounts(!!user);
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const activeAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;

  const { data: deletionStatus } = useAccountDeletionStatus({ enabled: !!user });
  // Hidden when the backend endpoint is unsupported (web parity).
  const accountDeletionSupported = deletionStatus?.supported ?? true;

  const displayName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';
  const email = user?.email || '';
  const languageName = availableLanguages.find((l) => l.code === currentLanguage)?.nativeName;

  const go = React.useCallback(
    (path: string) => {
      haptics.tap();
      router.push(path as any);
    },
    [router]
  );

  // Docs and Support open kortix.com in the browser.
  const openWebPage = React.useCallback((path: string) => {
    haptics.tap();
    const frontend = getFrontendUrl().replace(/\/$/, '');
    void Linking.openURL(`${frontend}${path}`).catch(() => {});
  }, []);

  // Sign out confirms in an AlertDialog. The dialog stays open while signing
  // out, so a failure is shown in place instead of in a second alert.
  const [signOutOpen, setSignOutOpen] = React.useState(false);
  const [signOutFailed, setSignOutFailed] = React.useState(false);

  const openSignOut = React.useCallback(() => {
    if (isSigningOut) return;
    haptics.warning();
    setSignOutFailed(false);
    setSignOutOpen(true);
  }, [isSigningOut]);

  const confirmSignOut = React.useCallback(async () => {
    haptics.medium();
    setSignOutFailed(false);
    const result = await signOut();
    if (result?.success) {
      haptics.success();
      setSignOutOpen(false);
      router.replace('/');
    } else {
      haptics.warning();
      setSignOutFailed(true);
    }
  }, [router, signOut]);

  return (
    <View className="flex-1 bg-background">
      <SettingsPage
        paddingBottom={tabBarClearance}
        contentInsetAdjustmentBehavior={TAB_SCROLL_INSET_ADJUSTMENT}
        header={
          <View className="items-center pb-2" style={{ paddingTop: profileTopPadding }}>
            <Avatar size={64} fallbackText={displayName} />
            <Text variant="large" className="mt-3">
              {displayName}
            </Text>
            {!!email && (
              <Text variant="muted" className="mt-0.5">
                {email}
              </Text>
            )}
          </View>
        }>
        <SettingsGroup title="Preferences">
          <SettingsRow icon={User} label="General" onPress={() => go('/(settings)/general')} />
          <SettingsRow icon={Palette} label="Appearance" right={<AppearanceToggle />} />
          <SettingsRow icon={Volume2} label="Sounds" onPress={() => go('/(settings)/sounds')} />
          <SettingsRow
            icon={Bell}
            label={t('notifications.title', 'Notifications')}
            onPress={() => go('/(settings)/notifications')}
          />
          <SettingsRow
            icon={Globe}
            label="Language"
            value={languageName}
            onPress={() => go('/(settings)/language')}
          />
        </SettingsGroup>

        <SettingsGroup title="Workspace">
          <SettingsRow
            icon={Users}
            label="Accounts"
            value={activeAccount?.name}
            onPress={() => go('/accounts')}
          />
          <SettingsRow icon={Wallet} label="Billing" onPress={() => go('/billing')} />
        </SettingsGroup>

        <SettingsGroup title="Help">
          <SettingsRow icon={BookOpen} label="Docs" external onPress={() => openWebPage('/docs')} />
          <SettingsRow icon={LifeBuoy} label="Support" external onPress={() => openWebPage('/support')} />
        </SettingsGroup>

        {/* Advanced lives here (moved from user settings): account deletion
            and sign out, destructive, at the bottom. */}
        {!!user && (
          <SettingsGroup title="Advanced">
            {accountDeletionSupported && (
              <SettingsRow
                icon={Trash2}
                label={
                  deletionStatus?.has_pending_deletion
                    ? t('accountDeletion.deletionScheduled')
                    : t('accountDeletion.deleteYourAccount')
                }
                badge={deletionStatus?.has_pending_deletion ? 'Scheduled' : undefined}
                destructive
                onPress={() => go('/(settings)/account-deletion')}
              />
            )}
            <SettingsRow
              icon={LogOut}
              label={t('settings.signOut')}
              destructive
              onPress={isSigningOut ? undefined : openSignOut}
            />
          </SettingsGroup>
        )}
      </SettingsPage>

      <AlertDialog
        open={signOutOpen}
        onOpenChange={(open) => {
          // Keep the dialog up until an in-flight sign out settles.
          if (!isSigningOut) setSignOutOpen(open);
        }}>
        <AlertDialogContent className="rounded-3xl border-0">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.signOut')}</AlertDialogTitle>
            <AlertDialogDescription className={signOutFailed ? 'text-destructive' : undefined}>
              {signOutFailed
                ? t('auth.signOutFailed', 'Unable to sign out. Check your connection and try again.')
                : t('auth.signOutConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild disabled={isSigningOut}>
              <Button variant="secondary" size="lg" className="rounded-full">
                <Text>{t('common.cancel')}</Text>
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              size="lg"
              className="rounded-full"
              disabled={isSigningOut}
              onPress={confirmSignOut}>
              <Text>
                {isSigningOut ? t('auth.signingOut', 'Signing out…') : t('settings.signOut')}
              </Text>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}
