/**
 * Account page — the app's one settings page.
 *
 * Two entry points render this same component:
 * - the Account tab (`presentation="tab"`): the page title is scroll content,
 *   and the page clears the tab bar;
 * - the project sidebar's avatar (`presentation="project"`, route
 *   `/projects/[id]/account`): a header with the hamburger that opens the
 *   project drawer. No Go back.
 *
 * Top to bottom: profile photo (tap to change) and name, the signed-in email
 * with the plan badge, Edit profile, Preferences, Workspace, Help, Advanced.
 * Layout rules: apps/mobile/design.md → Account tab and account screens.
 */

import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Bell,
  BookOpen,
  Camera,
  Globe,
  LifeBuoy,
  LogOut,
  Trash2,
  Users,
  Volume2,
  Wallet,
} from 'lucide-react-native';

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
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import {
  AppearanceRow,
  SettingsGroup,
  SettingsHeader,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import type { SheetRef } from '@/components/kortix/sheet';
import { PricingTierBadge } from '@/components/billing/PricingTierBadge';
import {
  TAB_SCROLL_INSET_ADJUSTMENT,
  usesNativeTabBar,
  useTabBarClearance,
} from '@/components/navigation/tab-bar-layout';
import { EditProfileSheet } from '@/components/settings/EditProfileSheet';
import { ProfilePicture } from '@/components/settings/ProfilePicture';
import { getFrontendUrl } from '@/api/config';
import { useAuthContext, useLanguage } from '@/contexts';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { useActiveAccount } from '@/hooks/useActiveAccount';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { useAccountState } from '@/lib/billing/hooks';
import { haptics } from '@/lib/haptics';

export interface AccountPageProps {
  /**
   * `tab`: the Account tab root. `project`: a route in the project stack, with
   * the hamburger header.
   */
  presentation: 'tab' | 'project';
  /** `project` only: open the project drawer (the header hamburger). */
  onOpenMenu?: () => void;
}

export function AccountPage({ presentation, onOpenMenu }: AccountPageProps) {
  const isTab = presentation === 'tab';
  const { user, signOut, isSigningOut } = useAuthContext();
  const { t, currentLanguage, availableLanguages } = useLanguage();
  const router = useRouter();
  const tabBarClearance = useTabBarClearance();
  const insets = useSafeAreaInsets();
  // The tab has no screen header. iOS scroll views inset the status bar
  // themselves (contentInsetAdjustmentBehavior="automatic"); the Android
  // floating tab bar screens pad for it here. 14pt matches the Projects tab
  // header's py-3.5, so both tab titles sit at the same height.
  const topPadding = usesNativeTabBar ? 14 : insets.top + 14;

  const profile = useProfileEditor();
  const editProfileRef = React.useRef<SheetRef>(null);

  const { account: activeAccount } = useActiveAccount();
  // Plan of the active account, shown as the plan badge next to the email.
  // Same plan name as BillingPage's Current plan row: the API's trial-aware
  // plan label first, then the stored tier name.
  const accountStateQuery = useAccountState({
    accountId: activeAccount?.account_id ?? undefined,
    enabled: !!activeAccount,
  });
  const accountState = accountStateQuery.data;
  const subscription = accountState?.subscription;
  const planName =
    accountState?.plan?.label ||
    (subscription ? subscription.tier_display_name || subscription.tier_key || 'Basic' : undefined);

  const { data: deletionStatus } = useAccountDeletionStatus({ enabled: !!user });
  // Hidden when the backend endpoint is unsupported (web parity).
  const accountDeletionSupported = deletionStatus?.supported ?? true;

  const languageName = availableLanguages.find((l) => l.code === currentLanguage)?.nativeName;
  const title = t('account.title', 'Account');

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

  const openEditProfile = React.useCallback(() => {
    haptics.tap();
    editProfileRef.current?.open();
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

  const profileHeader = (
    <ProfileHeader
      name={profile.displayName}
      avatarUrl={profile.avatarUrl}
      uploading={profile.isUploadingPhoto}
      onChangePhoto={profile.changePhoto}
    />
  );

  return (
    <View className="flex-1 bg-background">
      {isTab ? null : (
        <SettingsHeader title={title} gutter="project" onOpenMenu={onOpenMenu} />
      )}
      <SettingsPage
        gutter={isTab ? 'page' : 'project'}
        paddingBottom={isTab ? tabBarClearance : undefined}
        contentInsetAdjustmentBehavior={isTab ? TAB_SCROLL_INSET_ADJUSTMENT : undefined}
        header={
          isTab ? (
            // The page title is page content (no header bar), so it shares the
            // page background; h-10 matches the Projects header row height.
            <View className="gap-3.5" style={{ paddingTop: topPadding }}>
              <View className="h-10 justify-center">
                <Text variant="h3">{title}</Text>
              </View>
              {profileHeader}
            </View>
          ) : (
            profileHeader
          )
        }>
        {/* Who is signed in and on which plan, then the profile editor. */}
        <SettingsGroup>
          <SettingsRow
            label={profile.email}
            right={planName ? <PricingTierBadge planName={planName} size="md" /> : null}
          />
          <SettingsRow label={t('nameEdit.title', 'Edit profile')} onPress={openEditProfile} />
        </SettingsGroup>

        <SettingsGroup title={t('account.preferences', 'Preferences')}>
          <AppearanceRow />
          <SettingsRow icon={Volume2} label={t('account.sounds', 'Sounds')} onPress={() => go('/(settings)/sounds')} />
          <SettingsRow
            icon={Bell}
            label={t('notifications.title', 'Notifications')}
            onPress={() => go('/(settings)/notifications')}
          />
          <SettingsRow
            icon={Globe}
            label={t('settings.language', 'Language')}
            value={languageName}
            onPress={() => go('/(settings)/language')}
          />
        </SettingsGroup>

        <SettingsGroup title={t('account.workspace', 'Workspace')}>
          <SettingsRow
            icon={Users}
            label={t('account.accounts', 'Accounts')}
            value={activeAccount?.name}
            onPress={() => go('/accounts')}
          />
          <SettingsRow icon={Wallet} label={t('billing.title', 'Billing')} onPress={() => go('/billing')} />
        </SettingsGroup>

        <SettingsGroup title={t('account.help', 'Help')}>
          <SettingsRow icon={BookOpen} label={t('account.docs', 'Docs')} external onPress={() => openWebPage('/docs')} />
          <SettingsRow
            icon={LifeBuoy}
            label={t('account.support', 'Support')}
            external
            onPress={() => openWebPage('/support')}
          />
        </SettingsGroup>

        {/* Destructive actions last: account deletion and sign out. */}
        {!!user && (
          <SettingsGroup title={t('account.advanced', 'Advanced')}>
            {accountDeletionSupported && (
              <SettingsRow
                icon={Trash2}
                label={
                  deletionStatus?.has_pending_deletion
                    ? t('accountDeletion.deletionScheduled', 'Deletion scheduled')
                    : t('accountDeletion.deleteAccount', 'Delete account')
                }
                badge={
                  deletionStatus?.has_pending_deletion
                    ? t('accountDeletion.scheduledBadge', 'Scheduled')
                    : undefined
                }
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

      <EditProfileSheet
        ref={editProfileRef}
        name={profile.displayName}
        saving={profile.isSavingName}
        onSave={profile.saveName}
      />

      <AlertDialog
        open={signOutOpen}
        onOpenChange={(open) => {
          // Keep the dialog up until an in-flight sign out settles.
          if (!isSigningOut) setSignOutOpen(open);
        }}>
        <AlertDialogContent className="rounded-3xl">
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

/**
 * Profile photo and display name, centred above the first group. Tapping the
 * photo opens the system photo picker; the camera badge marks it as editable.
 */
function ProfileHeader({
  name,
  avatarUrl,
  uploading,
  onChangePhoto,
}: {
  name: string;
  avatarUrl: string;
  uploading: boolean;
  onChangePhoto: () => void;
}) {
  const { t } = useLanguage();
  return (
    <View className="items-center">
      <Pressable
        onPress={onChangePhoto}
        disabled={uploading}
        accessibilityRole="button"
        accessibilityLabel={t('profile.changePhoto', 'Change profile photo')}
        hitSlop={8}
        className="active:opacity-80">
        <ProfilePicture imageUrl={avatarUrl} size={20} fallbackText={name} />
        {uploading ? (
          <View className="absolute inset-0 items-center justify-center rounded-full bg-background/60">
            <KortixLoader size="small" />
          </View>
        ) : null}
        {/* The ring in the page colour cuts the badge out of the photo edge. */}
        <View className="absolute -bottom-0.5 -right-0.5 size-7 items-center justify-center rounded-full border-2 border-background bg-secondary">
          <Icon as={Camera} size={14} strokeWidth={2.2} className="text-foreground" />
        </View>
      </Pressable>
      {name ? (
        <Text variant="large" className="mt-3 text-center" numberOfLines={1}>
          {name}
        </Text>
      ) : null}
    </View>
  );
}
