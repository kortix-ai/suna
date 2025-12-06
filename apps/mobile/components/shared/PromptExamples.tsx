/**
 * PromptExamples Component
 * 
 * A reusable component for displaying prompt suggestions/follow-ups.
 * Used by ASK tool, COMPLETE tool, and inline message rendering.
 * Matches the frontend design: minimal list with hover states.
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowUpRight } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  withTiming,
  FadeIn,
  Layout
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PromptExample {
  text: string;
  icon?: React.ComponentType<{ className?: string; size?: number }>;
}

interface PromptExamplesProps {
  /** Array of prompt examples to display */
  prompts: PromptExample[] | string[];
  /** Callback when a prompt is clicked */
  onPromptClick?: (prompt: string) => void;
  /** Title shown above prompts */
  title?: string;
  /** Whether to show the title */
  showTitle?: boolean;
  /** Additional className for container */
  className?: string;
  /** Maximum number of prompts to display */
  maxPrompts?: number;
}

/**
 * Individual prompt item with press animation
 */
const PromptItem = React.memo(function PromptItem({
  prompt,
  index,
  onPress,
}: {
  prompt: PromptExample;
  index: number;
  onPress?: () => void;
}) {
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: scale.value },
      { translateX: translateX.value },
    ],
  }));

  const iconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value * 0.5 },
      { translateY: -translateX.value * 0.5 },
    ],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
    translateX.value = withTiming(0, { duration: 150 });
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Brief animation before callback
    translateX.value = withTiming(2, { duration: 100 });
    onPress?.();
  };

  return (
    <AnimatedPressable
      entering={FadeIn.delay(index * 30).duration(200)}
      layout={Layout.springify()}
      style={animatedStyle}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      className="rounded-lg active:bg-accent/50"
    >
      <View className="flex-row items-center justify-between gap-3 py-2.5">
        <Text 
          className="text-sm font-roobert text-foreground/70 flex-1 leading-relaxed"
          numberOfLines={3}
        >
          {prompt.text}
        </Text>
        <Animated.View style={iconAnimatedStyle}>
          <Icon 
            as={ArrowUpRight} 
            size={14} 
            className="text-muted-foreground/40 flex-shrink-0" 
          />
        </Animated.View>
      </View>
    </AnimatedPressable>
  );
});

/**
 * PromptExamples - Displays a list of clickable prompt suggestions
 * 
 * Matches frontend design:
 * - Minimal list style with subtle hover states
 * - ArrowUpRight icon that animates on interaction
 * - Optional title above the prompts
 */
export function PromptExamples({
  prompts,
  onPromptClick,
  title = 'Sample prompts',
  showTitle = true,
  className,
  maxPrompts = 4,
}: PromptExamplesProps) {
  // Normalize prompts to PromptExample format
  const normalizedPrompts: PromptExample[] = React.useMemo(() => {
    if (!prompts || prompts.length === 0) return [];
    
    return prompts.slice(0, maxPrompts).map((prompt) => {
      if (typeof prompt === 'string') {
        return { text: prompt };
      }
      return prompt;
    });
  }, [prompts, maxPrompts]);

  if (normalizedPrompts.length === 0) return null;

  return (
    <View className={className}>
      {showTitle && (
        <Text className="text-xs font-roobert text-muted-foreground/60 mb-2">
          {title}
        </Text>
      )}
      <View className="gap-1">
        {normalizedPrompts.map((prompt, index) => (
          <PromptItem
            key={`prompt-${index}-${prompt.text.substring(0, 20)}`}
            prompt={prompt}
            index={index}
            onPress={() => onPromptClick?.(prompt.text)}
          />
        ))}
      </View>
    </View>
  );
}

export default PromptExamples;
