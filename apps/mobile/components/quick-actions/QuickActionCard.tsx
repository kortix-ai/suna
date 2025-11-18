import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
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
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    console.log('🎯 Quick action pressed:', action.label);
    console.log('📊 Action data:', { id: action.id, label: action.label });
    action.onPress?.();
  };

  const isSelected = action.isSelected ?? false;

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
        className={isSelected ? 'text-primary-foreground mr-2' : 'text-foreground/70 mr-2'}
        strokeWidth={2}
      />
      <Text className={`text-sm font-roobert ${
        isSelected ? 'text-primary-foreground font-roobert-medium' : 'text-foreground/80'
      }`}>
        {action.label}
      </Text>
    </AnimatedPressable>
  );
}

