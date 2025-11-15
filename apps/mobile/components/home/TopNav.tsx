import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { TierBadge } from '@/components/menu/TierBadge';
import * as React from 'react';
import { Pressable, View, Dimensions } from 'react-native';
import { Menu, Coins, Sparkles } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useSubscription, useCreditBalance } from '@/lib/billing';
import { useColorScheme } from 'nativewind';
import { formatCredits } from '@/lib/utils/credit-formatter';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SCREEN_WIDTH = Dimensions.get('window').width;

interface TopNavProps {
  onMenuPress?: () => void;
  onUpgradePress?: () => void;
  onCreditsPress?: () => void;
}

export function TopNav({ onMenuPress, onUpgradePress, onCreditsPress }: TopNavProps) {
  const { colorScheme } = useColorScheme();
  const { data: subscriptionData } = useSubscription();
  const { data: creditBalance, refetch: refetchCredits } = useCreditBalance();
  const menuScale = useSharedValue(1);
  const upgradeScale = useSharedValue(1);
  const creditsScale = useSharedValue(1);
  const rightUpgradeScale = useSharedValue(1);

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
  const isFreeTier = currentTier === 'free' || !subscriptionData;
  const buttonWidth = 163;

  return (
    <View className="absolute top-[62px] left-0 right-0 flex-row items-center h-[41px] px-0 z-50">
      {/* Menu Icon - positioned at left: 24px, top: 70.5px (relative to screen) */}
      <AnimatedPressable
        onPressIn={() => {
          menuScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          menuScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        className="absolute left-6 w-6 h-6 items-center justify-center"
        onPress={handleMenuPress}
        style={[
          menuAnimatedStyle,
          { top: 8.5 } // 70.5 - 62 = 8.5px from container top
        ]}
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        accessibilityHint="Opens the navigation drawer"
      >
        <Icon as={Menu} size={24} className="text-foreground" strokeWidth={2} />
      </AnimatedPressable>

      {/* Upgrade Button with Plus Badge - centered horizontally, only show for free tier */}
      {isFreeTier && (
        <AnimatedPressable
          onPressIn={() => {
            upgradeScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
          }}
          onPressOut={() => {
            upgradeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          onPress={handleUpgradePress}
          style={[
            upgradeAnimatedStyle,
            {
              position: 'absolute',
              left: (SCREEN_WIDTH - buttonWidth) / 2, // Center horizontally
              width: buttonWidth,
              height: 41,
              borderWidth: 1.5,
              borderColor: colorScheme === 'dark' ? '#242427' : '#d0d0d0',
              backgroundColor: 'transparent',
              borderRadius: 16,
              paddingHorizontal: 16,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              overflow: 'visible', // Ensure content isn't clipped
            }
          ]}
          accessibilityRole="button"
          accessibilityLabel="Upgrade to Plus"
        >
          <Text 
            className="text-[14px] font-roobert-medium"
            style={{ 
              color: colorScheme === 'dark' ? '#f8f8f8' : '#121215',
              includeFontPadding: false,
              lineHeight: 17, // Match font size + 3px for proper spacing
            }}
          >
            Upgrade
          </Text>
          <TierBadge tier="Plus" size="small" />
        </AnimatedPressable>
      )}

      <View className="absolute right-6 flex-row items-center gap-2" style={{ top: 8.5 }}>
        {!isFreeTier && (
          <AnimatedPressable
            onPressIn={() => {
              rightUpgradeScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              rightUpgradeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            onPress={handleUpgradePress}
            className="flex-row h-9 px-3 items-center gap-1.5 bg-primary border-[1.5px] border-primary rounded-full"
            style={rightUpgradeAnimatedStyle}
            accessibilityRole="button"
            accessibilityLabel="Upgrade"
          >
            <Icon as={Sparkles} size={14} className="text-primary-foreground" strokeWidth={2.5} />
            <Text className="text-xs font-roobert-semibold text-primary-foreground">
              Upgrade
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
          className="flex-row items-center gap-2 bg-primary/10 border-[1.5px] border-primary/30 rounded-full px-3 py-1.5"
          style={creditsAnimatedStyle}
          accessibilityRole="button"
          accessibilityLabel="View usage"
          accessibilityHint="Opens usage details"
        >
          <Icon as={Coins} size={16} className="text-primary" strokeWidth={2.5} />
          <Text className="text-sm font-roobert-semibold text-primary">
            {formatCredits(creditBalance?.balance || 0)}
          </Text>
        </AnimatedPressable>
      </View>
    </View>
  );
}

