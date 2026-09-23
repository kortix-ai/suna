/**
 * Account page — the app's one settings page (COR-120: "less is more").
 *
 * Two entry points render this same component:
 * - the Account tab (`presentation="tab"`): the page title is scroll content,
 *   and the page clears the tab bar;
 * - the project sidebar's avatar (`presentation="project"`, route
 *   `/projects/[id]/account`): a header with the hamburger that opens the
 *   project drawer. No Go back.
 *
 * Top to bottom: profile tile (photo; name over email, the one two-line row;
 * opens EditProfileSheet),
 * an untitled group for the current project (project presentation only) and
 * the active account, Preferences, Help, Log out, the version footer, and a
 * quiet "Delete account" link. Layout rules:
 * apps/mobile/design.md → Account tab and account screens.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BellIcon as Bell,
  BookOpenIcon as BookOpen,
  CaretRightIcon as ChevronRight,
  GlobeIcon as Globe,
  LifebuoyIcon as LifeBuoy,
  SignOutIcon as LogOut,
  SpeakerHighIcon as Volume2,
} from '@/lib/icons';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import Constants from 'expo-constants';
import { useColorScheme } from 'nativewind';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/kortix/avatar';
import { KortixLogo } from '@/components/kortix/KortixLogo';
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
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { useAuthContext, useLanguage } from '@/contexts';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { useActiveAccount } from '@/hooks/useActiveAccount';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { useActivePlanName } from '@/hooks/useActivePlanName';
import { haptics } from '@/lib/haptics';
import { openLink } from '@/lib/utils/open-link';
import { LANGUAGE_PICKER_ENABLED } from '@/lib/utils/locale-config';

export interface AccountPageProps {
  /**
   * `tab`: the Account tab root. `project`: a route in the project stack, with
   * the hamburger header.
   */
  presentation: 'tab' | 'project';
  /** `project` only: open the project drawer (the header hamburger). */
  onOpenMenu?: () => void;
  /** `project` only: the open project's name, for the "current context" row. */
  projectName?: string;
  /**
   * `project` only: open the project Settings page (`page:settings`) — the
   * same navigation the project drawer's gear button uses
   * (`ProjectScreen.openProjectSettings`).
   */
  onOpenProjectSettings?: () => void;
}

export function AccountPage({
  presentation,
  onOpenMenu,
  projectName,
  onOpenProjectSettings,
}: AccountPageProps) {
  const isTab = presentation === 'tab';
  const isProject = presentation === 'project';
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
  // Plan of the active account, shown as the plan badge next to its name.
  const planName = useActivePlanName();

  const { data: deletionStatus } = useAccountDeletionStatus({ enabled: !!user });
  // Hidden when the backend endpoint is unsupported (web parity).
  const accountDeletionSupported = deletionStatus?.supported ?? true;

  const languageName = availableLanguages.find((l) => l.code === currentLanguage)?.nativeName;
  const title = t('account.title', 'Settings');

  const go = React.useCallback(
    (path: string) => {
      haptics.tap();
      router.push(path as any);
    },
    [router]
  );

  // Docs and Support open kortix.com in the in-app browser (`openLink`).
  const openWebPage = React.useCallback((path: string) => {
    haptics.tap();
    void openLink(`${KORTIX_WEB_URL}${path}`).catch(() => {});
  }, []);

  const openEditProfile = React.useCallback(() => {
    haptics.tap();
    editProfileRef.current?.open();
  }, []);

  const openProjectSettings = React.useCallback(() => {
    haptics.tap();
    onOpenProjectSettings?.();
  }, [onOpenProjectSettings]);

  const openAccount = React.useCallback(() => {
    if (!activeAccount) return;
    go(`/accounts/${activeAccount.account_id}`);
  }, [activeAccount, go]);

  const openDeleteAccount = React.useCallback(
    () => go('/(settings)/account-deletion'),
    [go]
  );

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
      {isTab ? null : (
        <SettingsHeader title={title} onOpenMenu={onOpenMenu} />
      )}
      <SettingsPage
        paddingBottom={isTab ? tabBarClearance : undefined}
        contentInsetAdjustmentBehavior={isTab ? TAB_SCROLL_INSET_ADJUSTMENT : undefined}
        header={
          isTab ? (
            // The page title is page content (no header bar), so it shares the
            // page background; h-10 matches the Projects header row height.
            <View className="h-10 justify-center" style={{ paddingTop: topPadding }}>
              <Text variant="h3">{title}</Text>
            </View>
          ) : undefined
        }>
        {/* Profile tile: photo, name over email — opens EditProfileSheet. */}
        <SettingsGroup>
          <ProfileTile
            avatarUrl={profile.avatarUrl}
            name={profile.displayName}
            email={profile.email}
            hint={t('account.editProfile', 'Edit profile')}
            onPress={openEditProfile}
          />
        </SettingsGroup>

        {/* Current context: the open project (project presentation only) and
            the active account. */}
        <SettingsGroup>
          {isProject && projectName ? (
            <SettingsRow
              leading={<Avatar chalk size={28} fallbackText={projectName} />}
              label={projectName}
              value={t('account.project', 'Project')}
              onPress={openProjectSettings}
            />
          ) : null}
          <SettingsRow
            leading={<Avatar chalk size={28} fallbackText={activeAccount?.name} />}
            label={activeAccount?.name ?? ''}
            onPress={openAccount}
            right={
              <View className="flex-row items-center gap-2">
                {planName ? <PricingTierBadge planName={planName} size="md" /> : null}
                <Icon as={ChevronRight} size={16} className="text-muted-foreground/70" />
              </View>
            }
          />
        </SettingsGroup>

        <SettingsGroup title={t('account.preferences', 'Preferences')}>
          <AppearanceRow />
          <SettingsRow icon={Volume2} label={t('account.sounds', 'Sounds')} onPress={() => go('/(settings)/sounds')} />
          <SettingsRow
            icon={Bell}
            label={t('notifications.title', 'Notifications')}
            onPress={() => go('/(settings)/notifications')}
          />
          {LANGUAGE_PICKER_ENABLED && (
            <SettingsRow
              icon={Globe}
              label={t('settings.language', 'Language')}
              value={languageName}
              onPress={() => go('/(settings)/language')}
            />
          )}
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

        {!!user && (
          <SettingsGroup>
            <SettingsRow
              icon={LogOut}
              label={t('account.logOut', 'Log out')}
              onPress={isSigningOut ? undefined : openSignOut}
            />
          </SettingsGroup>
        )}

        <AppVersionFooter />

        {!!user && accountDeletionSupported && (
          <DeleteAccountLink
            scheduled={!!deletionStatus?.has_pending_deletion}
            onPress={openDeleteAccount}
          />
        )}
      </SettingsPage>

      <EditProfileSheet
        ref={editProfileRef}
        name={profile.displayName}
        saving={profile.isSavingName}
        onSave={profile.saveName}
        avatarUrl={profile.avatarUrl}
        uploading={profile.isUploadingPhoto}
        onChangePhoto={profile.changePhoto}
      />

      <AlertDialog
        open={signOutOpen}
        onOpenChange={(open) => {
          // Keep the dialog up until an in-flight sign out settles.
          if (!isSigningOut) setSignOutOpen(open);
        }}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('account.logOut', 'Log out')}</AlertDialogTitle>
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
                {isSigningOut ? t('auth.signingOut', 'Signing out…') : t('account.logOut', 'Log out')}
              </Text>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}

/**
 * The profile tile (Paper board 04, "Profile"): 48pt photo, the display name
 * (16pt semibold, one line) over the email (14pt muted, one line), and the
 * row chevron. The one settings row with a second line (design.md §1 Row).
 * It sits in a `SettingsGroup`, so it has the same `bg-card` surface and
 * `rounded-2xl` corners as every other row, and the row's `px-4 py-3`.
 */
function ProfileTile({
  avatarUrl,
  name,
  email,
  hint,
  onPress,
}: {
  avatarUrl?: string | null;
  name: string;
  email: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={email ? `${name}, ${email}` : name}
      accessibilityHint={hint}
      className="active:bg-accent">
      <View className="flex-row items-center px-4 py-3">
        <View className="mr-3">
          <ProfilePicture imageUrl={avatarUrl} size={12} fallbackText={name} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="font-roobert-semibold" numberOfLines={1}>
            {name}
          </Text>
          {email ? (
            <Text variant="muted" numberOfLines={1}>
              {email}
            </Text>
          ) : null}
        </View>
        <View className="ml-3">
          <Icon as={ChevronRight} size={16} className="text-muted-foreground/70" />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Quiet centred text link, below the version footer: opens account deletion.
 * Reads "Deletion scheduled" once a deletion is pending. `minHeight: 44`
 * keeps the tap target at the HIG minimum despite the small, quiet label.
 */
function DeleteAccountLink({ scheduled, onPress }: { scheduled: boolean; onPress: () => void }) {
  const { t } = useLanguage();
  const label = scheduled
    ? t('accountDeletion.deletionScheduled', 'Deletion scheduled')
    : t('accountDeletion.deleteAccount', 'Delete account');
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="items-center justify-center active:opacity-70"
      style={{ minHeight: 44 }}>
      <Text variant="muted" className="text-center underline">
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The page's last line, centred (Jay, 2026-09-23): the Kortix logomark and the
 * app version, `v{x.y.z}` from `app.json` `expo.version`
 * (`Constants.expoConfig.version` — the same value in a store build, an OTA
 * update, and Expo Go, unlike `nativeApplicationVersion`, which reports Expo
 * Go's own version there). No version, no text.
 */
function AppVersionFooter() {
  const { colorScheme } = useColorScheme();
  const version = Constants.expoConfig?.version;
  return (
    <View
      className="flex-row items-center justify-center gap-2 py-8"
      accessible
      accessibilityLabel={version ? `Kortix version ${version}` : 'Kortix'}>
      <KortixLogo variant="logomark" size={14} color={colorScheme === 'dark' ? 'dark' : 'light'} className="opacity-50" />
      {version ? <Text variant="muted">v{version}</Text> : null}
    </View>
  );
}
