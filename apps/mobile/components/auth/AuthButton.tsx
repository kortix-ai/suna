import * as React from 'react';
import { Pressable, View, ActivityIndicator } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowRight } from 'lucide-react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface AuthButtonProps {
  label: string;
  onPress: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  showArrow?: boolean;
}

/**
 * AuthButton Component
 * 
 * Primary action button for authentication flows
 * - Sign in
 * - Sign up
 * - Reset password
 * - Continue
 * 
 * Features:
 * - Animated press feedback
 * - Loading state
 * - Optional arrow icon
 * 
 * Specifications:
 * - Height: 48px
 * - Border radius: 16px
 * - Primary: White background, dark text
 * - Secondary: Card background, foreground text
 */
export function AuthButton({
  label,
  onPress,
  isLoading = false,
  disabled = false,
  variant = 'primary',
  showArrow = true,
}: AuthButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    console.log('🎯 Auth button press in:', label);
    scale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handlePress = () => {
    console.log('🎯 Auth button pressed:', label);
    onPress();
  };

  const isPrimary = variant === 'primary';
  const isDisabled = disabled || isLoading;

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={isDisabled}
      style={animatedStyle}
      className="w-full"
    >
      <View
        className={`h-12 rounded-2xl ${
          isPrimary ? 'bg-primary' : 'bg-card border border-border'
        } ${isDisabled ? 'opacity-50' : ''}`}
      >
        <View className="flex-row items-center justify-center h-full px-6 gap-3">
          {isLoading ? (
            <ActivityIndicator
              size="small"
              color={isPrimary ? '#121215' : 'hsl(var(--foreground))'}
            />
          ) : (
            <>
              <Text
                className={`${
                  isPrimary ? 'text-primary-foreground' : 'text-foreground'
                } text-[14px] font-roobert-medium tracking-wide`}
              >
                {label}
              </Text>
              {showArrow && (
                <Icon
                  as={ArrowRight}
                  size={16}
                  className={isPrimary ? 'text-primary-foreground' : 'text-foreground'}
                />
              )}
            </>
          )}
        </View>
      </View>
    </AnimatedPressable>
  );
}

