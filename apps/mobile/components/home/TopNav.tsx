import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { TierBadge } from '@/components/menu/TierBadge';
import * as React from 'react';
import { Pressable, View, Dimensions } from 'react-native';
import { Menu } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { ThemeSwitcher } from './ThemeSwitcher';
import { useBillingContext } from '@/contexts/BillingContext';
import { useColorScheme } from 'nativewind';
import { NotificationBell } from '@/components/notifications';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SCREEN_WIDTH = Dimensions.get('window').width;

interface TopNavProps {
  onMenuPress?: () => void;
  onUpgradePress?: () => void;
}

/**
 * Top Navigation Bar Component
 * 
 * Navigation for new chat view:
 * - Menu icon (hamburger menu, opens side menu) at left: 24px, top: 70.5px
 * - Upgrade button with Pro badge at left: 115px, top: 62px
 * - Theme switcher
 * 
 * Specifications:
 * - Positioned at y:62px
 * - Height: 41px
 * - Animates on button presses
 * - Haptic feedback on menu open
 * 
 * Note: For thread view, use ThreadHeader component instead
 */
export function TopNav({ onMenuPress, onUpgradePress }: TopNavProps) {
  const { colorScheme } = useColorScheme();
  const { subscriptionData } = useBillingContext();
  const menuScale = useSharedValue(1);
  const upgradeScale = useSharedValue(1);

  const menuAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: menuScale.value }],
  }));

  const upgradeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: upgradeScale.value }],
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

  // Check if user needs upgrade (not Pro or higher)
  const currentTier = subscriptionData?.tier?.name || 'free';
  const needsUpgrade = currentTier !== 'pro' && currentTier !== 'business' && currentTier !== 'ultra';

  // Calculate button width dynamically based on content
  const buttonWidth = React.useMemo(() => {
    // Approximate width: "Upgrade" text (~70px) + gap (8px) + badge (12px icon + 4px gap + ~30px "Pro" text)
    // Total: ~124px, but using 163px from Figma design spec for consistency
    return 163;
  }, []);

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

      {/* Upgrade Button with Pro Badge - centered horizontally */}
      {needsUpgrade && (
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

      {/* Notifications & Theme Switcher - positioned at right */}
      <View className="absolute right-6 flex-row items-center gap-4">
        <NotificationBell />
        <ThemeSwitcher />
      </View>
    </View>
  );
}

