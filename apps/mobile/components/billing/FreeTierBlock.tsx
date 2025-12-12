/**
 * Free Tier Block Component
 *
 * A reusable component to block features for free tier users
 * Matches the frontend design from agent-configuration-dialog.tsx
 */

import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Server, Sparkles, Zap, Lock } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type FreeTierBlockVariant = 'integrations' | 'triggers' | 'automation' | 'custom';

interface FreeTierBlockProps {
  variant?: FreeTierBlockVariant;
  title?: string;
  description?: string;
  buttonText?: string;
  onUpgradePress: () => void;
  style?: 'card' | 'overlay' | 'banner';
}

const VARIANT_CONFIG = {
  integrations: {
    title: 'Unlock Integrations',
    description:
      'Connect Google Drive, Slack, Notion, and 100+ apps to supercharge your AI Workers',
    icon: Server,
    buttonText: 'Upgrade to Unlock',
  },
  triggers: {
    title: 'Unlock Triggers',
    description:
      'Schedule your AI Workers to run automatically or trigger them from external events',
    icon: Zap,
    buttonText: 'Upgrade to Unlock',
  },
  automation: {
    title: 'Unlock Automation',
    description: 'Run your AI Workers on autopilot with scheduled tasks and app-based triggers',
    icon: Zap,
    buttonText: 'Upgrade',
  },
  custom: {
    title: 'Upgrade Required',
    description: 'This feature requires a paid plan',
    icon: Lock,
    buttonText: 'Upgrade',
  },
};

export function FreeTierBlock({
  variant = 'custom',
  title,
  description,
  buttonText,
  onUpgradePress,
  style = 'card',
}: FreeTierBlockProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const scale = useSharedValue(1);
  const config = VARIANT_CONFIG[variant];
  const IconComponent = config.icon;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onUpgradePress();
  };

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  // Card content - used by both card and overlay styles
  const CardContent = () => (
    <View className="items-center gap-5">
      {/* Icon container - dark rounded square with subtle border */}
      <View
        className="h-16 w-16 items-center justify-center rounded-2xl"
        style={{
          backgroundColor: isDark ? '#2a2a2d' : '#f0f0f0',
          borderWidth: 1,
          borderColor: isDark ? '#3a3a3d' : '#e0e0e0',
        }}>
        <Icon
          as={IconComponent}
          size={28}
          color={isDark ? '#e8e8e8' : '#333333'}
          strokeWidth={1.5}
        />
      </View>

      {/* Title */}
      <Text
        className="text-center font-roobert-semibold text-xl"
        style={{ color: isDark ? '#ffffff' : '#000000' }}>
        {title || config.title}
      </Text>

      {/* Description */}
      <Text
        className="text-center text-base leading-relaxed"
        style={{
          color: isDark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(0, 0, 0, 0.6)',
          paddingHorizontal: 8,
        }}>
        {description || config.description}
      </Text>

      {/* Upgrade button - off-white/cream with dark text to match screenshot */}
      <Pressable
        onPress={handlePress}
        className="mt-2 flex-row items-center gap-2 rounded-full px-7 py-3.5 active:opacity-80"
        style={{
          backgroundColor: isDark ? '#f5f5f0' : '#1a1a1a',
        }}>
        <Sparkles size={16} color={isDark ? '#1a1a1a' : '#f5f5f0'} strokeWidth={2} />
        <Text
          className="font-roobert-semibold text-sm"
          style={{ color: isDark ? '#1a1a1a' : '#f5f5f0' }}>
          {buttonText || config.buttonText}
        </Text>
      </Pressable>
    </View>
  );

  if (style === 'overlay') {
    return (
      <View className="absolute inset-0 z-10">
        <View
          className="absolute inset-0"
          style={{ backgroundColor: isDark ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)' }}
        />
        <View className="relative flex-1 items-center justify-center px-6">
          <AnimatedPressable
            onPress={handlePress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            style={[
              animatedStyle,
              {
                backgroundColor: isDark ? '#1c1c1e' : '#ffffff',
                borderWidth: 1,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: isDark ? 0.3 : 0.1,
                shadowRadius: 20,
                elevation: 8,
              },
            ]}
            className="w-full max-w-sm rounded-3xl p-8">
            <CardContent />
          </AnimatedPressable>
        </View>
      </View>
    );
  }

  if (style === 'banner') {
    return (
      <AnimatedPressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[
          animatedStyle,
          {
            backgroundColor: isDark ? '#1c1c1e' : '#f8f8f8',
            borderWidth: 1,
            borderColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
          },
        ]}
        className="rounded-2xl p-4">
        <View className="flex-row items-center gap-3">
          <View
            className="h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl"
            style={{
              backgroundColor: isDark ? '#2a2a2d' : '#e8e8e8',
              borderWidth: 1,
              borderColor: isDark ? '#3a3a3d' : '#d0d0d0',
            }}>
            <Icon
              as={IconComponent}
              size={20}
              color={isDark ? '#e8e8e8' : '#333333'}
              strokeWidth={1.5}
            />
          </View>
          <View className="min-w-0 flex-1">
            <Text
              className="mb-0.5 font-roobert-semibold text-sm"
              style={{ color: isDark ? '#ffffff' : '#000000' }}>
              {title || config.title}
            </Text>
            <Text
              className="text-xs leading-relaxed"
              style={{ color: isDark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(0, 0, 0, 0.6)' }}
              numberOfLines={2}>
              {description || config.description}
            </Text>
          </View>
          <Pressable
            onPress={handlePress}
            className="flex-shrink-0 rounded-full px-4 py-2 active:opacity-80"
            style={{
              backgroundColor: isDark ? '#f5f5f0' : '#1a1a1a',
            }}>
            <Text
              className="font-roobert-semibold text-xs"
              style={{ color: isDark ? '#1a1a1a' : '#f5f5f0' }}>
              Upgrade
            </Text>
          </Pressable>
        </View>
      </AnimatedPressable>
    );
  }

  // Default 'card' style - matches the screenshot design
  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[
        animatedStyle,
        {
          backgroundColor: isDark ? '#1c1c1e' : '#ffffff',
          borderWidth: 1,
          borderColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: isDark ? 0.3 : 0.1,
          shadowRadius: 20,
          elevation: 8,
        },
      ]}
      className="rounded-3xl p-8">
      <CardContent />
    </AnimatedPressable>
  );
}
