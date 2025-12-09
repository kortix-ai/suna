import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { TierBadge } from '@/components/menu/TierBadge';
import * as React from 'react';
import { Pressable, View, Dimensions } from 'react-native';
import { Menu, Coins, Sparkles, TextAlignStart } from 'lucide-react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useCreditBalance } from '@/lib/billing';
import { useBillingContext } from '@/contexts/BillingContext';
import { useColorScheme } from 'nativewind';
import { formatCredits } from '@/lib/utils/credit-formatter';
import { useLanguage } from '@/contexts';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SCREEN_WIDTH = Dimensions.get('window').width;

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
  const { hasFreeTier, subscriptionData } = useBillingContext();
  const { data: creditBalance, refetch: refetchCredits } = useCreditBalance();
  const menuScale = useSharedValue(1);
  const upgradeScale = useSharedValue(1);
  const creditsScale = useSharedValue(1);
  const rightUpgradeScale = useSharedValue(1);
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

  const rightUpgradeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: rightUpgradeScale.value }],
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
    <View className="absolute left-0 right-0 top-[62px] z-50 h-[41px] flex-row items-center px-0">
      <AnimatedPressable
        onPressIn={() => {
          menuScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          menuScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        className="absolute left-6 h-6 w-6 items-center justify-center"
        onPress={handleMenuPress}
        style={[menuAnimatedStyle, { top: 8.5 }]}
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        accessibilityHint="Opens the navigation drawer">
        <Icon as={TextAlignStart} size={20} className="text-foreground" strokeWidth={2} />
      </AnimatedPressable>

      <View className="absolute right-6 flex-row items-center gap-2">
        {hasFreeTier && (
          <AnimatedPressable
            onPressIn={() => {
              rightUpgradeScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              rightUpgradeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            onPress={handleUpgradePress}
            className="h-9 flex-row items-center gap-1.5 rounded-full border-[1.5px] border-primary bg-primary px-3"
            style={rightUpgradeAnimatedStyle}
            accessibilityRole="button"
            accessibilityLabel="Upgrade">
            <Icon as={Sparkles} size={14} className="text-primary-foreground" strokeWidth={2.5} />
            <Text className="font-roobert-semibold text-xs text-primary-foreground">
              {t('billing.upgrade')}
            </Text>
          </AnimatedPressable>
        )}

        <AnimatedPressable
          onPressIn={() => {
            creditsScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
          }}
          onPressOut={() => {
            creditsScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          onPress={handleCreditsPress}
          className="flex-row items-center gap-2 rounded-full bg-primary/5 px-3 py-1.5"
          style={creditsAnimatedStyle}
          accessibilityRole="button"
          accessibilityLabel="View usage"
          accessibilityHint="Opens usage details">
          <Icon as={Coins} size={16} className="text-primary" strokeWidth={2.5} />
          <Text className="font-roobert-semibold text-sm text-primary">
            {formatCredits(creditBalance?.balance || 0)}
          </Text>
        </AnimatedPressable>
      </View>
    </View>
  );
}
