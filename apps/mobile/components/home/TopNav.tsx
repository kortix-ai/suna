import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { TierBadge } from '@/components/menu/TierBadge';
import * as React from 'react';
import { Pressable, View, Dimensions, Platform, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Menu, Coins, TextAlignStart } from 'lucide-react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useCreditBalance, useAccountState } from '@/lib/billing';
import { useBillingContext } from '@/contexts/BillingContext';
import { useColorScheme } from 'nativewind';
import { formatCredits } from '@/lib/utils/credit-formatter';
import { useLanguage } from '@/contexts';
import Svg, { Circle } from 'react-native-svg';

// NOTE: On Android, AnimatedPressable blocks touches - use TouchableOpacity instead
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SCREEN_WIDTH = Dimensions.get('window').width;

// Android hit slop for better touch targets
const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 10, bottom: 10, left: 10, right: 10 } : undefined;

interface CircularProgressProps {
  balance: number;
  limit: number;
}

function CircularProgress({ balance, limit }: CircularProgressProps) {
  const { colorScheme } = useColorScheme();
  const size = 20;
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  
  // Calculate percentage remaining (balance / limit)
  const percentageRemaining = Math.max(0, Math.min(100, (balance / limit) * 100));
  
  // Determine color based on percentage remaining with dark mode support
  const getColor = (percentage: number) => {
    if (percentage >= 60) return '#22c55e'; // green-500 (works well in both modes)
    if (percentage >= 20) return '#eab308'; // yellow-500 (works well in both modes)
    return '#ef4444'; // red-500 (works well in both modes)
  };
  
  const color = getColor(percentageRemaining);
  const backgroundColor = colorScheme === 'dark' 
    ? 'rgba(115, 115, 115, 0.3)' // neutral-500 with opacity for dark mode
    : 'rgba(163, 163, 163, 0.2)'; // neutral-400 with opacity for light mode
  
  // Calculate stroke dash offset for progress circle showing REMAINING tokens
  // When percentageRemaining = 100% → strokeDashoffset = 0 → full circle visible
  // When percentageRemaining = 0% → strokeDashoffset = circumference → no progress visible
  const strokeDashoffset = circumference * (1 - percentageRemaining / 100);
  
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        {/* Background circle (full circle) */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={backgroundColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Progress circle showing REMAINING tokens */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

interface TopNavProps {
  onMenuPress?: () => void;
  onUpgradePress?: () => void;
  onCreditsPress?: () => void;
  visible?: boolean;
}

export function TopNav({
  onMenuPress,
  onUpgradePress,
  onCreditsPress,
  visible = true,
}: TopNavProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const { subscriptionData } = useBillingContext();
  const { data: creditBalance, refetch: refetchCredits } = useCreditBalance();
  const { data: accountState } = useAccountState();
  const insets = useSafeAreaInsets();
  const menuScale = useSharedValue(1);
  const upgradeScale = useSharedValue(1);
  const creditsScale = useSharedValue(1);
  const centeredUpgradeScale = useSharedValue(1);
  const signUpButtonScale = useSharedValue(1);
  const loginButtonScale = useSharedValue(1);

  React.useEffect(() => {
    refetchCredits();
  }, []);

  const menuAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: menuScale.value }],
  }));

  const upgradeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: upgradeScale.value }],
  }));

  const creditsAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsScale.value }],
  }));

  const centeredUpgradeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: centeredUpgradeScale.value }],
  }));

  const signUpButtonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: signUpButtonScale.value }],
  }));

  const loginButtonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: loginButtonScale.value }],
  }));

  const handleMenuPress = () => {
    console.log('🎯 Menu panel pressed');
    console.log('📱 Opening menu drawer');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onMenuPress?.();
  };

  const handleUpgradePress = () => {
    console.log('🎯 Upgrade button pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onUpgradePress?.();
  };

  const handleCreditsPress = () => {
    console.log('🎯 Credits button pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    refetchCredits();
    onCreditsPress?.();
  };

  const currentTier = subscriptionData?.tier?.name || subscriptionData?.tier_key || 'free';
  const buttonWidth = 163;

  if (!visible) {
    return null;
  }

  return (
    <View 
      className="absolute left-0 right-0 top-0 z-50 flex-row items-center justify-between px-5"
      style={[
        { 
          paddingTop: insets.top + 8,
          paddingBottom: 24,
        },
        Platform.OS === 'android' ? { elevation: 50, zIndex: 50 } : undefined
      ]}
    >
      {/* Left: Menu Icon */}
      <TouchableOpacity
        onPress={handleMenuPress}
        style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}
        hitSlop={ANDROID_HIT_SLOP}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        accessibilityHint="Opens the navigation drawer">
        <Icon as={Menu} size={24} className="text-neutral-900 dark:text-neutral-100" strokeWidth={2} />
      </TouchableOpacity>

      {/* Right: Upgrade Button and Token Usage Circle */}
      <View className="flex-row items-center gap-2">
        {/* Upgrade Button */}
        <AnimatedPressable
          onPressIn={() => {
            centeredUpgradeScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
          }}
          onPressOut={() => {
            centeredUpgradeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          onPress={handleUpgradePress}
          className="h-10 flex-row items-center gap-1.5 rounded-full bg-neutral-900 dark:bg-neutral-100 px-3"
          style={centeredUpgradeAnimatedStyle}
          accessibilityRole="button"
          accessibilityLabel="Upgrade">
          <Text className="text-sm font-roobert-semibold text-neutral-50 dark:text-neutral-900">
            {t('billing.upgrade')}
          </Text>
        </AnimatedPressable>

        {/* Token Usage Button */}
        <TouchableOpacity
          onPress={handleCreditsPress}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 10, borderRadius: 20 }}
          className="bg-neutral-100 dark:bg-neutral-800"
          hitSlop={ANDROID_HIT_SLOP}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="View usage"
          accessibilityHint="Opens usage details">
          {(() => {
            const balance = creditBalance?.balance || 0;
            
            // Determine the credit limit based on tier type
            // For free tier and tiers with daily credits, use daily_amount
            // For paid tiers with monthly credits, use tier.monthly_credits
            const hasDailyCredits = accountState?.credits?.daily_refresh?.enabled;
            const dailyLimit = accountState?.credits?.daily_refresh?.daily_amount || 0;
            const monthlyLimit = subscriptionData?.tier?.credits || subscriptionData?.credits?.tier_credits || 0;
            
            // Use daily limit if daily credits are enabled, otherwise use monthly limit
            // Fallback to 100 if both are 0 (default for free tier)
            const limit = hasDailyCredits && dailyLimit > 0 
              ? dailyLimit 
              : monthlyLimit > 0 
                ? monthlyLimit 
                : 100;
            
            return (
              <>
                <CircularProgress balance={balance} limit={limit} />
                <Text className="font-roobert-medium text-sm text-neutral-600 dark:text-neutral-400">
                  {formatCredits(balance)}
                </Text>
              </>
            );
          })()}
        </TouchableOpacity>
      </View>
    </View>
  );
}
