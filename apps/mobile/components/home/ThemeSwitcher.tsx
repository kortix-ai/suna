import { Icon } from '@/components/ui/icon';
import { Moon, Sun } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring, 
  withSequence 
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * ThemeSwitcher Component
 * Toggle between dark and light modes
 */
export function ThemeSwitcher() {
  const { colorScheme, toggleColorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  const rotate = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: scale.value },
      { rotate: `${rotate.value}deg` }
    ],
  }));

  const handlePress = () => {
    // Animate the icon
    scale.value = withSequence(
      withSpring(0.8, { damping: 15, stiffness: 400 }),
      withSpring(1, { damping: 15, stiffness: 400 })
    );
    rotate.value = withSpring(rotate.value + 180, { damping: 20, stiffness: 200 });
    
    // Toggle the theme
    toggleColorScheme();
    
    console.log('🌓 Theme toggled to:', colorScheme === 'dark' ? 'light' : 'dark');
  };

  const isDark = colorScheme === 'dark';

  return (
    <AnimatedPressable
      onPress={handlePress}
      className="w-8 h-8 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700"
      style={animatedStyle}
    >
      <Icon 
        as={isDark ? Sun : Moon}
        size={18}
        className="text-neutral-700 dark:text-neutral-300"
      />
    </AnimatedPressable>
  );
}

