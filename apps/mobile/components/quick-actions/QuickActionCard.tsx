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
import { log } from '@/lib/logger';


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
    log.log('🎯 Quick action pressed:', translatedLabel);
    log.log('📊 Action data:', { id: action.id, label: translatedLabel });
    action.onPress?.();
  };

  const isSelected = action.isSelected ?? false;

  // Get icon color based on theme and selection state
  // Primary: #121215 (light) / #F8F8F8 (dark)
  // Foreground with 70% opacity: rgba(18, 18, 21, 0.7) (light) / rgba(248, 248, 248, 0.7) (dark)
  const iconColor = React.useMemo(() => {
    if (isSelected) {
      return colorScheme === 'dark' ? '#F8F8F8' : '#121215'; // primary
    }
    // 70% opacity
    return colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.7)' : 'rgba(18, 18, 21, 0.7)';
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
          ? 'bg-primary/10' 
          : 'bg-primary/5'
      }`}
      style={animatedStyle}
    >
      <Icon 
        as={action.icon} 
        size={18} 
        color={iconColor}
        className={isSelected ? 'text-primary mr-2' : 'text-foreground/70 mr-2'}
        strokeWidth={2}
      />
      <Text className={`text-sm font-roobert ${
        isSelected ? 'text-primary font-roobert-medium' : 'text-foreground/80'
      }`}>
        {translatedLabel}
      </Text>
    </AnimatedPressable>
  );
}

