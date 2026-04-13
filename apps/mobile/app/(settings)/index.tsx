import * as React from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Bell,
  ChevronRight,
  CreditCard,
  Globe,
  LogOut,
  Palette,
  Receipt,
  Trash2,
  User,
  Volume2,
  Wallet,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type SettingsIcon = typeof User;

interface SettingsRow {
  key: string;
  icon: SettingsIcon;
  label: string;
  description: string;
  onPress: () => void;
  badge?: string;
  destructive?: boolean;
  disabled?: boolean;
}

export default function SettingsScreen() {
  const { colorScheme } = useColorScheme();
  const { user, signOut, isSigningOut } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();
  const isGuest = !user;

  const { data: deletionStatus } = useAccountDeletionStatus({ enabled: !isGuest });

  const go = React.useCallback((path: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(path as any);
  }, [router]);

  const handlePlan = React.useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (useNativePaywall) {
      await presentUpgradePaywall();
      return;
    }
    router.push('/plans');
  }, [presentUpgradePaywall, router, useNativePaywall]);

  const handleSignOut = React.useCallback(async () => {
    if (isSigningOut) return;
    Alert.alert(
      t('settings.signOut'),
      t('auth.signOutConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.signOut'),
          style: 'destructive',
          onPress: async () => {
            const result = await signOut();
            if (result.success) {
              router.replace('/');
            } else {
              Alert.alert(t('common.error'), 'Failed to sign out. Please try again.');
            }
          },
        },
      ],
      { cancelable: true },
    );
  }, [isSigningOut, router, signOut, t]);

  const preferenceRows: SettingsRow[] = [
    {
      key: 'general',
      icon: User,
      label: 'General',
      description: 'Profile details and account controls',
      onPress: () => go('/(settings)/general'),
    },
    {
      key: 'appearance',
      icon: Palette,
      label: 'Appearance',
      description: 'Color mode, wallpaper, and palette',
      onPress: () => go('/(settings)/appearance'),
    },
    {
      key: 'sounds',
      icon: Volume2,
      label: 'Sounds',
      description: 'Feedback tones and haptics',
      onPress: () => go('/(settings)/sounds'),
    },
    {
      key: 'notifications',
      icon: Bell,
      label: t('notifications.title', 'Notifications'),
      description: t('notifications.description', 'Manage how you receive notifications'),
      onPress: () => go('/(settings)/notifications'),
    },
  ];

  const accountRows: SettingsRow[] = [
    {
      key: 'plan',
      icon: CreditCard,
      label: t('settings.plan', 'Plan'),
      description: 'Upgrade or manage your plan',
      onPress: handlePlan,
    },
    {
      key: 'billing',
      icon: Wallet,
      label: t('settings.billing', 'Billing'),
      description: 'Subscription and payment details',
      onPress: () => go('/(settings)/billing'),
    },
    {
      key: 'transactions',
      icon: Receipt,
      label: 'Transactions',
      description: 'Billing and credit transaction history',
      onPress: () => go('/(settings)/transactions'),
    },
  ];

  // Account deletion is hidden when the backend endpoint is unsupported
  // (matches web's `isBillingEnabled() && accountDeletionSupported` guard).
  const accountDeletionSupported = deletionStatus?.supported ?? true;

  const advancedRows: SettingsRow[] = [
    ...(accountDeletionSupported
      ? [
          {
            key: 'deletion',
            icon: Trash2,
            label: deletionStatus?.has_pending_deletion
              ? t('accountDeletion.deletionScheduled')
              : t('accountDeletion.deleteYourAccount'),
            description: 'Schedule or cancel account deletion',
            onPress: () => go('/(settings)/account-deletion'),
            badge: deletionStatus?.has_pending_deletion ? 'Scheduled' : undefined,
            destructive: true,
            disabled: isGuest,
          } as SettingsRow,
        ]
      : []),
    {
      key: 'logout',
      icon: LogOut,
      label: t('settings.signOut'),
      description: 'Sign out from this device',
      onPress: handleSignOut,
      destructive: true,
      disabled: isGuest,
    },
  ];

  const subtitleColor = colorScheme === 'dark' ? 'rgba(248,248,248,0.55)' : 'rgba(18,18,21,0.55)';

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}
    >
      <View className="px-5 pt-1 pb-2" style={{ gap: 18 }}>
        <SettingsGroup title="Preferences" rows={preferenceRows} />
        <SettingsGroup title="Account" rows={accountRows} />
        <SettingsGroup title="Advanced" rows={advancedRows} />

        {!isGuest && (
          <View className="px-1 pt-1">
            <View className="flex-row items-center">
              <Icon as={Globe} size={14} className="text-muted-foreground/70" strokeWidth={2} />
              <Text className="ml-2 text-xs font-roobert-medium text-muted-foreground/80">
                Logged in as {user?.email || 'user'}
              </Text>
            </View>
            <Text className="mt-1 text-[11px] font-roobert text-muted-foreground/60" style={{ color: subtitleColor }}>
              Mobile settings mirror frontend sections where features are available.
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function SettingsGroup({ title, rows }: { title: string; rows: SettingsRow[] }) {
  const visibleRows = rows.filter((r) => !r.disabled);
  if (visibleRows.length === 0) return null;

  return (
    <View className="px-1">
      <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
        {title}
      </Text>
      <View>
        {visibleRows.map((row, idx) => {
          const { key, ...rowProps } = row;
          return (
            <SettingsItem
              key={key}
              {...rowProps}
              isLast={idx === visibleRows.length - 1}
            />
          );
        })}
      </View>
    </View>
  );
}

function SettingsItem({
  icon,
  label,
  description,
  onPress,
  badge,
  destructive = false,
  isLast = false,
}: SettingsRow & { isLast?: boolean }) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = React.useCallback(() => {
    scale.value = withSpring(0.985, { damping: 16, stiffness: 420 });
  }, [scale]);

  const handlePressOut = React.useCallback(() => {
    scale.value = withSpring(1, { damping: 16, stiffness: 420 });
  }, [scale]);

  const iconTint = destructive ? 'text-destructive' : 'text-foreground/80';
  const titleTint = destructive ? 'text-destructive' : 'text-foreground';

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="active:opacity-90"
    >
      <View className="py-3.5">
        <View className="flex-row items-center">
          <Icon as={icon} size={18} className={iconTint} strokeWidth={2.2} />

          <View className="ml-4 flex-1">
            <View className="flex-row items-center">
              <Text className={`font-roobert-medium text-[15px] ${titleTint}`}>{label}</Text>
              {!!badge && (
                <View className="ml-2 rounded-full bg-destructive/15 px-2 py-0.5">
                  <Text className="text-[10px] font-roobert-medium text-destructive">{badge}</Text>
                </View>
              )}
            </View>
            <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">{description}</Text>
          </View>

          <Icon as={ChevronRight} size={16} className="text-muted-foreground/50" strokeWidth={2.2} />
        </View>
      </View>

      {!isLast && <View className="h-px bg-border/35" />}
    </AnimatedPressable>
  );
}
