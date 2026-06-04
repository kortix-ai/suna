/**
 * UpgradeSnack Component
 *
 * Shows an upgrade banner for free tier users at the start of the session.
 * Displays cycling tier badges (Plus, Pro, Ultra) and dismisses on any interaction.
 * Matches the frontend chat-snack.tsx upgrade notification behavior.
 */

import React, { useEffect, useCallback } from 'react';
import { View, Pressable, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  Easing,
  runOnJS,
  withRepeat,
  withSequence,
  interpolate,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { TierBadge } from '@/components/billing/TierBadge';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.3;

// Tier badge cycling order (matches frontend)
const BADGE_ORDER = ['Ultra', 'Plus', 'Pro'] as const;
const BADGE_CYCLE_DURATION = 1200; // ms per badge

interface UpgradeSnackProps {
  /** Whether the snack is visible */
  isVisible: boolean;
  /** Callback when pressing the snack to open upgrade */
  onPress?: () => void;
  /** Callback when user dismisses (X button or swipe) */
  onDismiss?: () => void;
}

export const UpgradeSnack = React.memo(function UpgradeSnack({
  isVisible,
  onPress,
  onDismiss,
}: UpgradeSnackProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Animation values
  const translateY = useSharedValue(20);
  const translateX = useSharedValue(0);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.95);

  // Badge cycling state
  const [currentBadgeIndex, setCurrentBadgeIndex] = React.useState(0);
  const badgeOpacity = useSharedValue(1);
  const badgeTranslateY = useSharedValue(0);

  // Cycle through badges
  useEffect(() => {
    if (!isVisible) return;

    const interval = setInterval(() => {
      // Animate out
      badgeOpacity.value = withTiming(0, { duration: 150 });
      badgeTranslateY.value = withTiming(-8, { duration: 150 });

      // After animation out, change badge and animate in
      setTimeout(() => {
        setCurrentBadgeIndex(prev => (prev + 1) % 3);
        badgeTranslateY.value = 8;
        badgeOpacity.value = withTiming(1, { duration: 150 });
        badgeTranslateY.value = withTiming(0, { duration: 150 });
      }, 150);
    }, BADGE_CYCLE_DURATION);

    return () => clearInterval(interval);
  }, [isVisible]);

  // Haptic feedback helper
  const triggerHaptic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Dismiss handler
  const handleDismiss = useCallback(() => {
    triggerHaptic();
    onDismiss?.();
  }, [onDismiss]);

  // Pan gesture for swipe to dismiss
  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onUpdate((event) => {
      translateX.value = event.translationX;
      const progress = Math.abs(event.translationX) / SWIPE_THRESHOLD;
      opacity.value = Math.max(0.3, 1 - progress * 0.7);
    })
    .onEnd((event) => {
      const shouldDismiss = Math.abs(event.translationX) > SWIPE_THRESHOLD;

      if (shouldDismiss) {
        const direction = event.translationX > 0 ? 1 : -1;
        translateX.value = withTiming(direction * SCREEN_WIDTH, { duration: 200 });
        opacity.value = withTiming(0, { duration: 200 });
        runOnJS(handleDismiss)();
      } else {
        translateX.value = withSpring(0, { damping: 20, stiffness: 300 });
        opacity.value = withSpring(1, { damping: 20, stiffness: 300 });
      }
    });

  // Animate in/out
  useEffect(() => {
    if (isVisible) {
      translateX.value = 0;
      translateY.value = withSpring(0, { damping: 20, stiffness: 300 });
      opacity.value = withTiming(1, { duration: 200 });
      scale.value = withSpring(1, { damping: 20, stiffness: 300 });
    } else {
      translateY.value = withTiming(20, { duration: 150, easing: Easing.in(Easing.ease) });
      opacity.value = withTiming(0, { duration: 150 });
      scale.value = withTiming(0.95, { duration: 150 });
    }
  }, [isVisible, translateY, translateX, opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
    opacity: opacity.value,
  }));

  const badgeAnimatedStyle = useAnimatedStyle(() => ({
    opacity: badgeOpacity.value,
    transform: [{ translateY: badgeTranslateY.value }],
  }));

  if (!isVisible) {
    return null;
  }

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View style={animatedStyle} className="mx-3 mb-2">
        <Pressable
          onPress={() => {
            triggerHaptic();
            onPress?.();
          }}
          className="flex-row items-center gap-3 rounded-3xl p-2 border border-border bg-card active:opacity-80"
        >
          {/* Cycling Tier Badge - fixed width to prevent layout shift */}
          <View style={{ width: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View style={badgeAnimatedStyle}>
              <TierBadge
                planName={BADGE_ORDER[currentBadgeIndex]}
                size="xxs"
              />
            </Animated.View>
          </View>

          {/* Content */}
          <View className="flex-1 min-w-0">
            <Text
              className="text-sm font-roobert-medium text-foreground"
              numberOfLines={1}
            >
              Unlock the full Kortix experience
            </Text>
            <Text
              className="text-xs text-muted-foreground"
              numberOfLines={1}
            >
              Advanced mode, 100+ Integrations & more
            </Text>
          </View>

          {/* Close Button */}
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              handleDismiss();
            }}
            className="w-8 h-8 rounded-full items-center justify-center active:opacity-70"
            style={{
              backgroundColor: isDark ? 'rgba(113, 113, 122, 0.2)' : 'rgba(113, 113, 122, 0.1)',
            }}
          >
            <Icon as={X} size={16} className="text-muted-foreground" />
          </Pressable>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
});
