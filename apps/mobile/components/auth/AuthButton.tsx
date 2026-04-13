import * as React from 'react';
import { Pressable, View, ActivityIndicator } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowRight } from 'lucide-react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface AuthButtonProps {
  label: string;
  loadingLabel?: string;
  onPress: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  showArrow?: boolean;
}

/**
 * AuthButton — animated auth action button with inline loading state.
 *
 * Loading state shows a spinner next to a loading label (e.g. "Signing in...")
 * instead of replacing the entire button content.
 */
export function AuthButton({
  label,
  loadingLabel,
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
    scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const isPrimary = variant === 'primary';
  const isDisabled = disabled || isLoading;

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={isDisabled}
      style={animatedStyle}
      className="w-full"
    >
      <View
        className={`h-[52px] rounded-2xl ${
          isPrimary ? 'bg-primary' : 'bg-card border border-border'
        } ${isDisabled ? 'opacity-70' : ''}`}
      >
        <View className="flex-row items-center justify-center h-full px-6 gap-2.5">
          {isLoading && (
            <ActivityIndicator
              size="small"
              color={isPrimary ? '#FFFFFF' : undefined}
              style={{ marginRight: 2 }}
            />
          )}
          <Text
            className={`${
              isPrimary ? 'text-primary-foreground' : 'text-foreground'
            } text-[15px] font-roobert-medium`}
          >
            {isLoading ? (loadingLabel || label) : label}
          </Text>
          {!isLoading && showArrow && (
            <Icon
              as={ArrowRight}
              size={16}
              className={isPrimary ? 'text-primary-foreground' : 'text-foreground'}
            />
          )}
        </View>
      </View>
    </AnimatedPressable>
  );
}
