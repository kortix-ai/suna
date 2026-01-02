import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { QuickAction } from '.';


const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface QuickActionCardProps {
  action: QuickAction;
}

/**
 * QuickActionCard Component
 * 
 * Individual quick action card with icon and label.
 * Features smooth scale animation on press.
 */
export function QuickActionCard({ action }: QuickActionCardProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  
  // Get translated label
  const translatedLabel = t(`quickActions.${action.id}`, { defaultValue: action.label });
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    console.log('🎯 Quick action pressed:', translatedLabel);
    console.log('📊 Action data:', { id: action.id, label: translatedLabel });
    action.onPress?.();
  };

  const isSelected = action.isSelected ?? false;

  // Get icon color based on theme and selection state using neutral colors
  // neutral-900 (light) / neutral-50 (dark) for selected
  // neutral-700 (light) / neutral-300 (dark) for unselected with opacity
  const iconColor = React.useMemo(() => {
    if (isSelected) {
      return colorScheme === 'dark' ? '#fafafa' : '#171717'; // neutral-50 / neutral-900
    }
    // 70% opacity for unselected state
    return colorScheme === 'dark' ? 'rgba(212, 212, 212, 0.7)' : 'rgba(64, 64, 64, 0.7)'; // neutral-300 / neutral-700
  }, [isSelected, colorScheme]);

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      className={`flex-row items-center px-4 py-2.5 rounded-2xl ${
        isSelected 
          ? 'bg-neutral-100 dark:bg-neutral-800' 
          : 'bg-neutral-50 dark:bg-neutral-900'
      }`}
      style={animatedStyle}
    >
      <Icon 
        as={action.icon} 
        size={18} 
        color={iconColor}
        className={isSelected ? 'text-neutral-900 dark:text-neutral-50 mr-2' : 'text-neutral-700 dark:text-neutral-300 mr-2'}
        strokeWidth={2}
      />
      <Text className={`text-sm font-roobert ${
        isSelected ? 'text-neutral-900 dark:text-neutral-50 font-roobert-medium' : 'text-neutral-700 dark:text-neutral-300'
      }`}>
        {translatedLabel}
      </Text>
    </AnimatedPressable>
  );
}

