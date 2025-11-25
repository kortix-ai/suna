import * as React from 'react';
import { Pressable, View, Alert, ScrollView } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  User,
  CreditCard,
  Moon,
  Sun,
  Globe,
  LogOut,
  ChevronRight,
  FlaskConical,
  Trash2
} from 'lucide-react-native';
import type { UserProfile } from '../menu/types';
import { LanguagePage } from './LanguagePage';
import { NameEditPage } from './NameEditPage';
import { ThemePage } from './ThemePage';
import { BetaPage } from './BetaPage';
import { BillingPage } from './BillingPage';
import { CreditsPurchasePage } from './CreditsPurchasePage';
import { UsagePage } from './UsagePage';
import { AccountDeletionPage } from './AccountDeletionPage';
import { SettingsHeader } from './SettingsHeader';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
import * as Haptics from 'expo-haptics';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { useAuthDrawerStore } from '@/stores/auth-drawer-store';
import { useGuestMode } from '@/contexts';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface SettingsPageProps {
  visible: boolean;
  profile?: UserProfile;
  onClose: () => void;
}

export function SettingsPage({ visible, profile, onClose }: SettingsPageProps) {
  const { colorScheme } = useColorScheme();
  const { user, signOut } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();
  const { isGuestMode } = useGuestMode();
  const [isLanguagePageVisible, setIsLanguagePageVisible] = React.useState(false);
  const [isNameEditPageVisible, setIsNameEditPageVisible] = React.useState(false);
  const [isThemePageVisible, setIsThemePageVisible] = React.useState(false);
  const [isBetaPageVisible, setIsBetaPageVisible] = React.useState(false);
  const [isBillingPageVisible, setIsBillingPageVisible] = React.useState(false);
  const [isCreditsPurchasePageVisible, setIsCreditsPurchasePageVisible] = React.useState(false);
  const [isUsagePageVisible, setIsUsagePageVisible] = React.useState(false);
  const [isAccountDeletionPageVisible, setIsAccountDeletionPageVisible] = React.useState(false);
  const [isIntegrationsPageVisible, setIsIntegrationsPageVisible] = React.useState(false);

  const isGuest = !user || isGuestMode;

  const { data: deletionStatus } = useAccountDeletionStatus({
    enabled: visible && !isGuest,
  });

  const userName = React.useMemo(() =>
    user?.user_metadata?.full_name || user?.email?.split('@')[0] || profile?.name || 'Guest',
    [user?.user_metadata?.full_name, user?.email, profile?.name]
  );

  const userEmail = React.useMemo(() =>
    user?.email || profile?.email || '',
    [user?.email, profile?.email]
  );

  const userAvatar = React.useMemo(() =>
    user?.user_metadata?.avatar_url || profile?.avatar,
    [user?.user_metadata?.avatar_url, profile?.avatar]
  );

  const userTier = profile?.tier;

  // Memoize handlers to prevent unnecessary re-renders
  const handleClose = React.useCallback(() => {
    console.log('🎯 Settings page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleName = React.useCallback(() => {
    console.log('🎯 Name/Profile management pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsNameEditPageVisible(true);
  }, []);

  const handleBilling = React.useCallback(() => {
    console.log('🎯 Billing pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (isGuestMode) {
      useAuthDrawerStore.getState().openAuthDrawer({
        title: 'Sign up to continue',
        message: 'Create an account to manage your billing and subscription'
      });
      return;
    }

    setIsBillingPageVisible(true);
  }, [isGuestMode]);

  const handleIntegrations = React.useCallback(() => {
    console.log('🎯 Integrations pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsIntegrationsPageVisible(true);
  }, []);

  const handleTheme = React.useCallback(() => {
    console.log('🎯 Theme pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsThemePageVisible(true);
  }, []);

  const handleLanguage = React.useCallback(() => {
    console.log('🎯 App Language pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsLanguagePageVisible(true);
  }, []);

  const handleBeta = React.useCallback(() => {
    console.log('🎯 Beta pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (isGuestMode) {
      useAuthDrawerStore.getState().openAuthDrawer({
        title: 'Sign up to continue',
        message: 'Create an account to access beta features'
      });
      return;
    }

    setIsBetaPageVisible(true);
  }, [isGuestMode]);

  const handleAccountDeletion = React.useCallback(() => {
    console.log('🎯 Account deletion pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (isGuestMode) {
      useAuthDrawerStore.getState().openAuthDrawer({
        title: 'Sign up to continue',
        message: 'Create an account to manage your account settings'
      });
      return;
    }

    setIsAccountDeletionPageVisible(true);
  }, [isGuestMode]);

  const handleSignOut = React.useCallback(async () => {
    console.log('🎯 Sign Out pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    Alert.alert(
      t('settings.signOut'),
      t('auth.signOutConfirm'),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => console.log('❌ Sign out cancelled'),
        },
        {
          text: t('settings.signOut'),
          style: 'destructive',
          onPress: async () => {
            console.log('🔐 Signing out...');
            const result = await signOut();
            if (result.success) {
              console.log('✅ Signed out successfully - Redirecting to auth');
              onClose();
              router.replace('/');
            } else {
              console.error('❌ Sign out failed:', result.error);
              Alert.alert(t('common.error'), 'Failed to sign out. Please try again.');
            }
          },
        },
      ],
      { cancelable: true }
    );
  }, [t, signOut, onClose, router]);


  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <SettingsHeader
            title={t('settings.title')}
            onClose={handleClose}
          />

          {/* Settings List */}
          <View className="px-6">
            <SettingsItem
              icon={User}
              label={t('settings.name')}
              onPress={handleName}
            />

            <SettingsItem
              icon={CreditCard}
              label={t('settings.billing')}
              onPress={handleBilling}
            />

            <SettingsItem
              icon={colorScheme === 'dark' ? Sun : Moon}
              label={t('settings.themeTitle') || 'Theme'}
              onPress={handleTheme}
            />

            <SettingsItem
              icon={Globe}
              label={t('settings.language')}
              onPress={handleLanguage}
            />

            <SettingsItem
              icon={FlaskConical}
              label={t('settings.beta') || 'Beta'}
              onPress={handleBeta}
            />
            {!isGuest && (
              <SettingsItem
                icon={Trash2}
                label={deletionStatus?.has_pending_deletion ? t('accountDeletion.deletionScheduled') : t('accountDeletion.deleteYourAccount')}
                onPress={handleAccountDeletion}
                showBadge={deletionStatus?.has_pending_deletion}
              />
            )}
            {!isGuest && (
              <SettingsItem
                icon={LogOut}
                label={t('settings.signOut')}
                onPress={handleSignOut}
              />
            )}
          </View>
          <View className="h-20" />
        </ScrollView>
      </View>

      <AnimatedPageWrapper visible={isLanguagePageVisible} onClose={() => setIsLanguagePageVisible(false)}>
        <LanguagePage
          visible
          onClose={() => setIsLanguagePageVisible(false)}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper visible={isNameEditPageVisible} onClose={() => setIsNameEditPageVisible(false)}>
        <NameEditPage
          visible
          currentName={userName}
          onClose={() => setIsNameEditPageVisible(false)}
          onNameUpdated={(newName) => {
            console.log('✅ Name updated to:', newName);
          }}
          isGuestMode={isGuestMode}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper visible={isThemePageVisible} onClose={() => setIsThemePageVisible(false)}>
        <ThemePage
          visible
          onClose={() => setIsThemePageVisible(false)}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper visible={isBetaPageVisible} onClose={() => setIsBetaPageVisible(false)}>
        <BetaPage
          visible
          onClose={() => setIsBetaPageVisible(false)}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper visible={isBillingPageVisible} onClose={() => setIsBillingPageVisible(false)} disableGesture>
        <BillingPage
          visible
          onClose={() => setIsBillingPageVisible(false)}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper visible={isCreditsPurchasePageVisible} onClose={() => setIsCreditsPurchasePageVisible(false)}>
        <CreditsPurchasePage
          visible
          onClose={() => setIsCreditsPurchasePageVisible(false)}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper visible={isUsagePageVisible} onClose={() => setIsUsagePageVisible(false)}>
        <UsagePage
          visible
          onClose={() => setIsUsagePageVisible(false)}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper visible={isAccountDeletionPageVisible} onClose={() => setIsAccountDeletionPageVisible(false)}>
        <AccountDeletionPage
          visible
          onClose={() => setIsAccountDeletionPageVisible(false)}
        />
      </AnimatedPageWrapper>
    </View>
  );
}

interface SettingsItemProps {
  icon: typeof User;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  showBadge?: boolean;
}

const SettingsItem = React.memo(({ icon, label, onPress, destructive = false, showBadge = false }: SettingsItemProps) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = React.useCallback(() => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  }, [scale]);

  const handlePressOut = React.useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  }, [scale]);

  const iconColor = destructive ? 'text-destructive' : 'dark:text-muted-foreground/50 text-muted/80';
  const textColor = destructive ? 'text-destructive' : 'text-foreground';

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="flex-row items-center justify-between py-4"
    >
      <View className="flex-row items-center gap-3">
        <Icon as={icon} size={20} className={iconColor} strokeWidth={2} />
        <Text className={`text-lg font-roobert-medium ${textColor}`}>
          {label}
        </Text>
        {showBadge && (
          <View className="bg-destructive/20 px-2 py-0.5 rounded-full">
            <Text className="text-xs font-roobert-medium text-destructive">
              Scheduled
            </Text>
          </View>
        )}
      </View>

      {!destructive && (
        <Icon as={ChevronRight} size={16} className="text-foreground/40" strokeWidth={2} />
      )}
    </AnimatedPressable>
  );
});

