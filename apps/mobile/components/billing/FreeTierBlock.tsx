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
import { THEME } from '@/lib/utils/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type FreeTierBlockVariant = 'connections' | 'triggers' | 'automation' | 'custom';

interface FreeTierBlockProps {
  variant?: FreeTierBlockVariant;
  title?: string;
  description?: string;
  buttonText?: string;
  onUpgradePress: () => void;
  style?: 'card' | 'overlay' | 'banner';
}

const VARIANT_CONFIG = {
  connections: {
    title: 'Unlock Connections',
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
  const c = isDark ? THEME.dark : THEME.light;
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
      {/* Icon container - muted rounded square with subtle border */}
      <View className="h-16 w-16 items-center justify-center rounded-2xl border border-border bg-muted">
        <Icon as={IconComponent} size={28} color={c.foreground} strokeWidth={1.5} />
      </View>

      {/* Title */}
      <Text className="text-center font-roobert-semibold text-xl text-foreground">
        {title || config.title}
      </Text>

      {/* Description */}
      <Text
        className="text-center text-base leading-relaxed text-muted-foreground"
        style={{ paddingHorizontal: 8 }}>
        {description || config.description}
      </Text>

      {/* Upgrade button - primary surface, inverts light/dark to match screenshot */}
      <Pressable
        onPress={handlePress}
        className="mt-2 flex-row items-center gap-2 rounded-full px-7 py-3.5 active:opacity-80 bg-primary">
        <Sparkles size={16} color={c.primaryForeground} strokeWidth={2} />
        <Text className="font-roobert-semibold text-sm text-primary-foreground">
          {buttonText || config.buttonText}
        </Text>
      </Pressable>
    </View>
  );

  if (style === 'overlay') {
    return (
      <View className="absolute inset-0 z-10">
        <View className="absolute inset-0 bg-background/80" />
        <View className="relative flex-1 items-center justify-center px-6">
          <AnimatedPressable
            onPress={handlePress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            style={[
              animatedStyle,
              {
                shadowColor: '#000', // hex-allowlist: universal shadow ink, not a themed surface color
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: isDark ? 0.3 : 0.1,
                shadowRadius: 20,
                elevation: 8,
              },
            ]}
            className="w-full max-w-sm rounded-3xl p-8 border border-border bg-card">
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
        style={animatedStyle}
        className="rounded-2xl p-4 border border-border bg-card">
        <View className="flex-row items-center gap-3">
          <View className="h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
            <Icon as={IconComponent} size={20} color={c.foreground} strokeWidth={1.5} />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="mb-0.5 font-roobert-semibold text-sm text-foreground">
              {title || config.title}
            </Text>
            <Text
              className="leading-relaxed text-muted-foreground"
              style={{ fontSize: 12 }}
              numberOfLines={2}>
              {description || config.description}
            </Text>
          </View>
          <Pressable
            onPress={handlePress}
            className="flex-shrink-0 rounded-full px-4 py-2 active:opacity-80 bg-primary">
            <Text
              className="font-roobert-semibold text-primary-foreground"
              style={{ fontSize: 12 }}>
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
          shadowColor: '#000', // hex-allowlist: universal shadow ink, not a themed surface color
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: isDark ? 0.3 : 0.1,
          shadowRadius: 20,
          elevation: 8,
        },
      ]}
      className="rounded-3xl p-8 border border-border bg-card">
      <CardContent />
    </AnimatedPressable>
  );
}
