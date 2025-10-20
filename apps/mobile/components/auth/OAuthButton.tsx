import * as React from 'react';
import { Pressable, View, Image } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import type { OAuthButtonProps } from './types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * OAuthButton Component
 * 
 * OAuth provider sign-in button
 * - Google
 * - GitHub
 * - Apple
 * 
 * Features:
 * - Provider icon
 * - Animated press feedback
 * - Loading state
 * 
 * Specifications:
 * - Height: 48px
 * - Border radius: 16px
 * - Border: border-border with 12% opacity
 */
export function OAuthButton({ provider, onPress, isLoading = false }: OAuthButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    console.log('🎯 OAuth button press in:', provider.name);
    scale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handlePress = () => {
    console.log('🎯 OAuth button pressed:', provider.name);
    onPress();
  };

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={isLoading}
      style={animatedStyle}
      className="w-full"
    >
      <View className="h-12 rounded-2xl border border-border/10 bg-card/50">
        <View className="flex-row items-center justify-center h-full px-4 gap-2">
          {provider.iconSource ? (
            <Image 
              source={provider.iconSource} 
              style={{ width: 20, height: 20 }}
              resizeMode="contain"
            />
          ) : provider.icon && typeof provider.icon !== 'function' ? (
            <Icon 
              as={provider.icon as any} 
              size={20} 
              className="text-foreground"
            />
          ) : null}
          <Text className="text-foreground text-[14px] font-roobert-medium tracking-wide">
            Continue with {provider.name}
          </Text>
        </View>
      </View>
    </AnimatedPressable>
  );
}

