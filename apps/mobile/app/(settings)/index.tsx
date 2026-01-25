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
} from 'lucide-react-native';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function SettingsScreen() {
  const { colorScheme } = useColorScheme();
  const { user, signOut, isSigningOut } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();
  const isGuest = !user;

  const { data: deletionStatus } = useAccountDeletionStatus({
    enabled: !isGuest,
  });

  const handleName = React.useCallback(() => {
    log.log('🎯 Name/Profile management pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/(settings)/name');
  }, [router]);

  const handlePlan = React.useCallback(async () => {
    log.log('🎯 Plan pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (useNativePaywall) {
      log.log('📱 Using native RevenueCat paywall');
      await presentUpgradePaywall();
    } else {
      router.push('/plans');
    }
  }, [useNativePaywall, presentUpgradePaywall, router]);

  const handleBilling = React.useCallback(() => {
    log.log('🎯 Billing pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/billing');
  }, [router]);

  const handleUsage = React.useCallback(() => {
    log.log('🎯 Usage pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/usage');
  }, [router]);

  const handleTheme = React.useCallback(() => {
    log.log('🎯 Theme pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/(settings)/theme');
  }, [router]);

  const handleLanguage = React.useCallback(() => {
    log.log('🎯 App Language pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/(settings)/language');
  }, [router]);

  const handleBeta = React.useCallback(() => {
    log.log('🎯 Beta pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/(settings)/beta');
  }, [router]);

  const handleAccountDeletion = React.useCallback(() => {
    log.log('🎯 Account deletion pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/(settings)/account-deletion');
  }, [router]);

  const handleSignOut = React.useCallback(async () => {
    if (isSigningOut) return;

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
  }, [t, signOut, router, isSigningOut]);

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
    >
      <View className="px-6 pt-4">
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
    </ScrollView>
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
        className="flex-row items-center justify-between py-4"
      >
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
