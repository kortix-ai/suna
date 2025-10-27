import { Icon } from '@/components/ui/icon';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { ThemeSwitcher } from '../theme/ThemeSwitcher';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TopNavProps {
  onMenuPress?: () => void;
}

/**
 * Top Navigation Bar Component
 * 
 * Navigation for new chat view:
 * - ChevronRight icon (opens side menu)
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
export function TopNav({ onMenuPress }: TopNavProps) {
  const menuScale = useSharedValue(1);

  const menuAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: menuScale.value }],
  }));

  const handleMenuPress = () => {
    console.log('🎯 Menu panel pressed');
    console.log('📱 Opening menu drawer');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onMenuPress?.();
  };

  return (
    <View className="absolute top-16 left-0 right-0 flex-row items-center h-10 px-6 z-50">
      {/* Left side - Chevron Menu and Theme Switcher */}
      <View className="flex-row items-center gap-3">
        <AnimatedPressable
          onPressIn={() => {
            menuScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
          }}
          onPressOut={() => {
            menuScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          className="w-6 h-6"
          onPress={handleMenuPress}
          style={menuAnimatedStyle}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          accessibilityHint="Opens the navigation drawer"
        >
          <Icon as={ChevronRight} size={24} className="text-foreground" strokeWidth={2} />
        </AnimatedPressable>
        <ThemeSwitcher />
      </View>
    </View>
  );
}

