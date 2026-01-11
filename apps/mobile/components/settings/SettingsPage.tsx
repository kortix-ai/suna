import * as React from 'react';
import { Pressable, View, Alert, ScrollView } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withTiming,
  Easing,
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
  Trash2,
  Wallet,
  BarChart3,
  Plug,
} from 'lucide-react-native';
import { KortixLoader } from '@/components/ui/kortix-loader';
import type { UserProfile } from '../menu/types';
import { LanguagePage } from './LanguagePage';
import { NameEditPage } from './NameEditPage';
import { ThemePage } from './ThemePage';
import { BetaPage } from './BetaPage';
import { BillingPage } from './BillingPage';
import { PlanPage } from './PlanPage';
import { UsagePage } from './UsagePage';
import { AccountDeletionPage } from './AccountDeletionPage';
import { SettingsHeader } from './SettingsHeader';
import { IntegrationsPage } from './IntegrationsPage';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
import * as Haptics from 'expo-haptics';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface SettingsPageProps {
  visible: boolean;
  profile?: UserProfile;
  onClose: () => void;
}

export function SettingsPage({ visible, profile, onClose }: SettingsPageProps) {
  const { colorScheme } = useColorScheme();
  const { user, signOut, isSigningOut } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();
  const [isLanguagePageVisible, setIsLanguagePageVisible] = React.useState(false);
  const [isNameEditPageVisible, setIsNameEditPageVisible] = React.useState(false);
  const [isThemePageVisible, setIsThemePageVisible] = React.useState(false);
  const [isBetaPageVisible, setIsBetaPageVisible] = React.useState(false);
  const [isPlanPageVisible, setIsPlanPageVisible] = React.useState(false);
  const [isBillingPageVisible, setIsBillingPageVisible] = React.useState(false);
  const [isUsagePageVisible, setIsUsagePageVisible] = React.useState(false);
  const [isAccountDeletionPageVisible, setIsAccountDeletionPageVisible] = React.useState(false);
  const [isIntegrationsPageVisible, setIsIntegrationsPageVisible] = React.useState(false);

  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();
  const isGuest = !user;

  const { data: deletionStatus } = useAccountDeletionStatus({
    enabled: visible && !isGuest,
  });

  const userName = React.useMemo(
    () => user?.user_metadata?.full_name || user?.email?.split('@')[0] || profile?.name || 'Guest',
    [user?.user_metadata?.full_name, user?.email, profile?.name]
  );

  const userEmail = React.useMemo(
    () => user?.email || profile?.email || '',
    [user?.email, profile?.email]
  );

  const userAvatar = React.useMemo(
    () => user?.user_metadata?.avatar_url || profile?.avatar,
    [user?.user_metadata?.avatar_url, profile?.avatar]
  );

  const userTier = profile?.tier;

  // Memoize handlers to prevent unnecessary re-renders
  const handleClose = React.useCallback(() => {
    log.log('🎯 Settings page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleName = React.useCallback(() => {
    log.log('🎯 Name/Profile management pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsNameEditPageVisible(true);
  }, []);

  const handlePlan = React.useCallback(async () => {
    log.log('🎯 Plan pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // If RevenueCat is available, present native paywall directly
    if (useNativePaywall) {
      log.log('📱 Using native RevenueCat paywall');
      await presentUpgradePaywall();
    } else {
      // Otherwise, show the custom PlanPage
      setIsPlanPageVisible(true);
    }
  }, [useNativePaywall, presentUpgradePaywall]);

  const handleBilling = React.useCallback(() => {
    log.log('🎯 Billing pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsBillingPageVisible(true);
  }, []);

  const handleUsage = React.useCallback(() => {
    log.log('🎯 Usage pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsUsagePageVisible(true);
  }, []);

  const handleIntegrations = React.useCallback(() => {
    log.log('🎯 Integrations pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsIntegrationsPageVisible(true);
  }, []);

  const handleTheme = React.useCallback(() => {
    log.log('🎯 Theme pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsThemePageVisible(true);
  }, []);

  const handleLanguage = React.useCallback(() => {
    log.log('🎯 App Language pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsLanguagePageVisible(true);
  }, []);

  const handleBeta = React.useCallback(() => {
    log.log('🎯 Beta pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    setIsBetaPageVisible(true);
  }, []);

  const handleAccountDeletion = React.useCallback(() => {
    log.log('🎯 Account deletion pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    setIsAccountDeletionPageVisible(true);
  }, []);

  const handleSignOut = React.useCallback(async () => {
    if (isSigningOut) return; // Prevent multiple sign out attempts

    log.log('🎯 Sign Out pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    Alert.alert(
      t('settings.signOut'),
      t('auth.signOutConfirm'),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => log.log('❌ Sign out cancelled'),
        },
        {
          text: t('settings.signOut'),
          style: 'destructive',
          onPress: async () => {
            log.log('🔐 Signing out...');
            const result = await signOut();
            if (result.success) {
              log.log('✅ Signed out successfully - Redirecting to auth');
              onClose();
              router.replace('/');
            } else {
              log.error('❌ Sign out failed:', result.error);
              Alert.alert(t('common.error'), 'Failed to sign out. Please try again.');
            }
          },
        },
      ],
      { cancelable: true }
    );
  }, [t, signOut, onClose, router, isSigningOut]);

  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable onPress={handleClose} className="absolute inset-0 bg-black/50" />
      <View className="absolute bottom-0 left-0 right-0 top-0 bg-background">
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}>
          <SettingsHeader title={t('settings.title')} onClose={handleClose} />

          {/* Settings List */}
          <View className="px-6">
            <SettingsItem icon={User} label={t('settings.name')} onPress={handleName} />

            <SettingsItem
              icon={CreditCard}
              label={t('settings.plan', 'Plan')}
              onPress={handlePlan}
            />

            <SettingsItem
              icon={Wallet}
              label={t('settings.billing', 'Billing')}
              onPress={handleBilling}
            />

            <SettingsItem
              icon={BarChart3}
              label={t('settings.usage', 'Usage')}
              onPress={handleUsage}
            />

            {/* <SettingsItem
              icon={Plug}
              label={t('integrations.title', 'Integrations')}
              onPress={handleIntegrations}
            /> */}

            <SettingsItem
              icon={colorScheme === 'dark' ? Sun : Moon}
              label={t('settings.themeTitle') || 'Theme'}
              onPress={handleTheme}
            />

            <SettingsItem icon={Globe} label={t('settings.language')} onPress={handleLanguage} />

            <SettingsItem
              icon={FlaskConical}
              label={t('settings.beta') || 'Beta'}
              onPress={handleBeta}
            />

            {!isGuest && (
              <SettingsItem
                icon={Trash2}
                label={
                  deletionStatus?.has_pending_deletion
                    ? t('accountDeletion.deletionScheduled')
                    : t('accountDeletion.deleteYourAccount')
                }
                onPress={handleAccountDeletion}
                showBadge={deletionStatus?.has_pending_deletion}
              />
            )}
            {!isGuest && (
              <SettingsItem
                icon={LogOut}
                label={t('settings.signOut')}
                onPress={handleSignOut}
                isLoading={isSigningOut}
              />
            )}
          </View>
          <View className="h-20" />
        </ScrollView>
      </View>

      <AnimatedPageWrapper
        visible={isLanguagePageVisible}
        onClose={() => setIsLanguagePageVisible(false)}>
        <LanguagePage visible onClose={() => setIsLanguagePageVisible(false)} />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper
        visible={isNameEditPageVisible}
        onClose={() => setIsNameEditPageVisible(false)}>
        <NameEditPage
          visible
          currentName={userName}
          onClose={() => setIsNameEditPageVisible(false)}
          onNameUpdated={(newName) => {
            log.log('✅ Name updated to:', newName);
          }}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper
        visible={isThemePageVisible}
        onClose={() => setIsThemePageVisible(false)}>
        <ThemePage visible onClose={() => setIsThemePageVisible(false)} />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper visible={isBetaPageVisible} onClose={() => setIsBetaPageVisible(false)}>
        <BetaPage visible onClose={() => setIsBetaPageVisible(false)} />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper
        visible={isPlanPageVisible}
        onClose={() => setIsPlanPageVisible(false)}
        disableGesture>
        <PlanPage visible onClose={() => setIsPlanPageVisible(false)} />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper
        visible={isBillingPageVisible}
        onClose={() => setIsBillingPageVisible(false)}
        disableGesture>
        <BillingPage
          visible
          onClose={() => setIsBillingPageVisible(false)}
          onChangePlan={async () => {
            setIsBillingPageVisible(false);
            // If RevenueCat is available, present the native paywall directly
            if (useNativePaywall) {
              log.log('📱 Using RevenueCat paywall from billing');
              setTimeout(async () => {
                await presentUpgradePaywall();
              }, 100);
            } else {
              // Otherwise show the custom plan page
              log.log('📄 Using custom plan page from billing');
              setTimeout(() => setIsPlanPageVisible(true), 100);
            }
          }}
        />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper
        visible={isUsagePageVisible}
        onClose={() => setIsUsagePageVisible(false)}>
        <UsagePage visible onClose={() => setIsUsagePageVisible(false)} />
      </AnimatedPageWrapper>

      <AnimatedPageWrapper
        visible={isAccountDeletionPageVisible}
        onClose={() => setIsAccountDeletionPageVisible(false)}>
        <AccountDeletionPage visible onClose={() => setIsAccountDeletionPageVisible(false)} />
      </AnimatedPageWrapper>
      {/* <AnimatedPageWrapper
        visible={isIntegrationsPageVisible}
        onClose={() => setIsIntegrationsPageVisible(false)}>
        <IntegrationsPage visible onClose={() => setIsIntegrationsPageVisible(false)} />
      </AnimatedPageWrapper> */}
    </View>
  );
}

interface SettingsItemProps {
  icon: typeof User;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  showBadge?: boolean;
  isLoading?: boolean;
}

const SettingsItem = React.memo(
  ({
    icon,
    label,
    onPress,
    destructive = false,
    showBadge = false,
    isLoading = false,
  }: SettingsItemProps) => {
    const scale = useSharedValue(1);
    const rotation = useSharedValue(0);

    React.useEffect(() => {
      if (isLoading) {
        rotation.value = withRepeat(
          withTiming(360, { duration: 1000, easing: Easing.linear }),
          -1,
          false
        );
      } else {
        rotation.value = 0;
      }
    }, [isLoading, rotation]);

    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ scale: scale.value }],
      opacity: isLoading ? 0.6 : 1,
    }));

    const iconAnimatedStyle = useAnimatedStyle(() => ({
      transform: [{ rotate: `${rotation.value}deg` }],
    }));

    const handlePressIn = React.useCallback(() => {
      if (!isLoading) {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
      }
    }, [scale, isLoading]);

    const handlePressOut = React.useCallback(() => {
      if (!isLoading) {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }
    }, [scale, isLoading]);

    const iconColor = destructive ? 'text-destructive' : 'text-primary';
    const textColor = destructive ? 'text-destructive' : 'text-foreground';

    return (
      <AnimatedPressable
        onPress={isLoading ? undefined : onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={isLoading}
        style={animatedStyle}
        className="flex-row items-center justify-between py-4">
        <View className="flex-row items-center gap-3">
          {isLoading ? (
            <KortixLoader size="small" customSize={20} />
          ) : (
            <Icon as={icon} size={20} className={iconColor} strokeWidth={2} />
          )}
          <Text className={`font-roobert-medium text-lg ${textColor}`}>{label}</Text>
          {showBadge && (
            <View className="rounded-full bg-destructive/20 px-2 py-0.5">
              <Text className="font-roobert-medium text-xs text-destructive">Scheduled</Text>
            </View>
          )}
        </View>

        {!destructive && !isLoading && (
          <Icon as={ChevronRight} size={16} className="text-foreground/40" strokeWidth={2} />
        )}
      </AnimatedPressable>
    );
  }
);
