import * as React from 'react';
import { Pressable, View, Alert, ScrollView, StyleSheet, TouchableOpacity, Platform } from 'react-native';
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
  X,
} from 'lucide-react-native';
import { KortixLoader } from '@/components/ui/kortix-loader';
import type { UserProfile } from '../menu/types';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';
import { useAccountDeletionStatus } from '@/hooks/useAccountDeletion';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { log } from '@/lib/logger';
import { cn } from '@/lib';
import { ProfilePicture } from './ProfilePicture';
import { getBackgroundColor, getDrawerBackgroundColor, getPadding } from '@agentpress/shared';

type PageType = 'main' | 'name' | 'language' | 'theme' | 'beta' | 'account-deletion';

interface SettingsPageProps {
  visible: boolean;
  profile?: UserProfile;
  onClose: () => void;
  isDrawer?: boolean;
  onNavigate?: (page: PageType) => void;
}

export function SettingsPage({ visible, profile, onClose, isDrawer = false, onNavigate }: SettingsPageProps) {
  const { colorScheme } = useColorScheme();
  const { user, signOut, isSigningOut } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();

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
    if (onNavigate) {
      onNavigate('name');
    }
  }, [onNavigate]);

  const handlePlan = React.useCallback(async () => {
    log.log('🎯 Plan pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // If RevenueCat is available, present native paywall directly
    if (useNativePaywall) {
      log.log('📱 Using native RevenueCat paywall');
      await presentUpgradePaywall();
    } else {
      // Navigate to plans route (full screen)
      router.push('/plans');
    }
  }, [useNativePaywall, presentUpgradePaywall, router]);

  const handleBilling = React.useCallback(() => {
    log.log('🎯 Billing pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/plans');
  }, [router]);

  const handleUsage = React.useCallback(() => {
    log.log('🎯 Usage pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/usage');
  }, [router]);

  const handleTheme = React.useCallback(() => {
    log.log('🎯 Theme pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onNavigate) {
      onNavigate('theme');
    }
  }, [onNavigate]);

  const handleLanguage = React.useCallback(() => {
    log.log('🎯 App Language pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onNavigate) {
      onNavigate('language');
    }
  }, [onNavigate]);

  const handleBeta = React.useCallback(() => {
    log.log('🎯 Beta pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onNavigate) {
      onNavigate('beta');
    }
  }, [onNavigate]);

  const handleAccountDeletion = React.useCallback(() => {
    log.log('🎯 Account deletion pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onNavigate) {
      onNavigate('account-deletion');
    }
  }, [onNavigate]);

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

  const settingsContent = (
    <View style={{ 
      flex: 1, 
      backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme),
      paddingHorizontal: getPadding(Platform.OS, 'md'),
      paddingTop: getPadding(Platform.OS, 'sm'),
      paddingBottom: 100,
    }}>
      <TouchableOpacity 
        onPress={handleName}
        activeOpacity={0.7}
        style={{
          paddingVertical: 16,
          paddingHorizontal: 16,
          marginBottom: 8,
        }}
        className="flex-row items-center justify-between bg-muted-foreground/10 rounded-3xl">
        <View className="flex-row items-center gap-3 flex-1">
          <ProfilePicture size={12} imageUrl={user?.user_metadata?.avatar_url} fallbackText={userName} />
          <View className="flex-1">
            <Text className="font-roobert-bold text-lg text-foreground">
              {userName}
            </Text>
            <Text className="font-roobert-medium text-sm text-muted-foreground">
              {userEmail}
            </Text>
          </View>
        </View>
        <Icon
          as={ChevronRight}
          size={20}
          color={colorScheme === 'dark' ? '#48484A' : '#C7C7CC'}
          strokeWidth={2.5}
        />
      </TouchableOpacity>
      <SettingsSection title={t('settings.account', 'Account')}>
        <SettingsItem icon={CreditCard} label={t('settings.plan', 'Plan')} onPress={handlePlan} />
        <SettingsSeparator />
        <SettingsItem icon={Wallet} label={t('settings.billing', 'Billing')} onPress={handleBilling} />
        <SettingsSeparator />
        <SettingsItem icon={BarChart3} label={t('settings.usage', 'Usage')} onPress={handleUsage} />
      </SettingsSection>

      <SettingsSection title={t('settings.preferences', 'Preferences')}>
        <SettingsItem
          icon={colorScheme === 'dark' ? Sun : Moon}
          label={t('settings.themeTitle') || 'Theme'}
          onPress={handleTheme}
        />
        <SettingsSeparator />
        <SettingsItem icon={Globe} label={t('settings.language')} onPress={handleLanguage} />
        <SettingsSeparator />
        <SettingsItem icon={FlaskConical} label={t('settings.beta') || 'Beta'} onPress={handleBeta} />
      </SettingsSection>

      {!isGuest && (
        <SettingsSection>
          <SettingsItem
            icon={Trash2}
            label={
              deletionStatus?.has_pending_deletion
                ? t('accountDeletion.deletionScheduled')
                : t('accountDeletion.deleteYourAccount')
            }
            onPress={handleAccountDeletion}
            showBadge={deletionStatus?.has_pending_deletion}
            destructive
          />
          <SettingsSeparator />
          <SettingsItem
            icon={LogOut}
            label={t('settings.signOut')}
            onPress={handleSignOut}
            isLoading={isSigningOut}
            destructive
          />
        </SettingsSection>
      )}
      
      {/* Bottom spacing */}
      <View style={{ height: 32 }} />
    </View>
  );

  // Render as drawer content (no wrapper, no header)
  if (isDrawer) {
    return settingsContent;
  }

  // Render as full-page modal (with wrapper and header)
  return (
    <View className="absolute inset-0 z-50">
      <Pressable onPress={handleClose} className="absolute inset-0 bg-black/50" />
      <View className="absolute bottom-0 left-0 right-0 top-0 bg-background">
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}>
          <SettingsHeader title={t('settings.title')} onClose={handleClose} />

          {settingsContent}
          
          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

// Settings Section Header
interface SettingsSectionProps {
  title?: string;
  children: React.ReactNode;
}

const SettingsSection = ({ title, children }: SettingsSectionProps) => {
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';
  
  return (
    <View style={{ marginTop: title ? (isIOS ? 20 : 0) : (isIOS ? 16 : 0) }}>
      {title && isIOS && (
        <Text
          style={{
            fontSize: 13,
            fontWeight: '400',
            color: colorScheme === 'dark' ? '#8E8E93' : '#6E6E73',
            marginBottom: 8,
            paddingLeft: 16,
            textTransform: 'uppercase',
          }}>
          {title}
        </Text>
      )}
      {title && !isIOS && (
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 8,
          }}>
          <Text
            style={{
              fontSize: 14,
              fontWeight: '500',
              color: colorScheme === 'dark' ? '#BB86FC' : '#6200EE',
            }}>
            {title}
          </Text>
        </View>
      )}
      <View
        style={isIOS ? {
          borderRadius: 20,
          overflow: 'hidden',
        } : {
          backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF',
          marginBottom: 8,
        }}
        className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
      >
        {children}
      </View>
    </View>
  );
};

// Settings Separator (hairline between items)
const SettingsSeparator = () => {
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';
  
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
        marginLeft: isIOS ? 52 : 16, // iOS: align with text after icon, Android: standard indent
      }}
    />
  );
};

// Settings Item
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
    const { colorScheme } = useColorScheme();
    const rotation = useSharedValue(0);
    const isIOS = Platform.OS === 'ios';

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

    const iconAnimatedStyle = useAnimatedStyle(() => ({
      transform: [{ rotate: `${rotation.value}deg` }],
    }));

    return (
      <TouchableOpacity
        onPress={isLoading ? undefined : onPress}
        disabled={isLoading}
        activeOpacity={0.6}
        style={{
          paddingHorizontal: 16,
          paddingVertical: isIOS ? 11 : 14,
          minHeight: isIOS ? 44 : 56,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: isIOS ? 12 : 16, flex: 1 }}>
          {isLoading ? (
            <View style={{ width: 20, height: 20 }}>
              <KortixLoader size="small" customSize={20} />
            </View>
          ) : (
            <Animated.View style={[iconAnimatedStyle]}>
              <Icon 
                as={icon} 
                size={isIOS ? 20 : 24} 
                className={cn(
                  colorScheme === 'dark' ? 'text-foreground' : 'text-foreground', 
                  destructive ? 'text-destructive' : 'text-foreground'
                )} 
                strokeWidth={2} 
              />
            </Animated.View>
          )}
          <Text 
            style={{ 
              fontSize: isIOS ? 17 : 16, 
              flex: 1,
              fontWeight: isIOS ? '400' : '500'
            }} 
            className={cn(
              colorScheme === 'dark' ? 'text-foreground' : 'text-foreground', 
              destructive ? 'text-destructive' : 'text-foreground'
            )}>
            {label}
          </Text>
          {showBadge && (
            <View
              style={{
                backgroundColor: colorScheme === 'dark' ? 'rgba(255, 59, 48, 0.2)' : 'rgba(255, 59, 48, 0.15)',
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 4,
              }}>
              <Text style={{ fontSize: 12, color: '#FF3B30', fontWeight: '500' }}>Scheduled</Text>
            </View>
          )}
        </View>

        {!destructive && !isLoading && (
          <Icon
            as={ChevronRight}
            size={isIOS ? 20 : 24}
            color={colorScheme === 'dark' ? '#48484A' : '#C7C7CC'}
            strokeWidth={2.5}
          />
        )}
      </TouchableOpacity>
    );
  }
);
