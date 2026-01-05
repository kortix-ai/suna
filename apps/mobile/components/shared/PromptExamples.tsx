/**
 * PromptExamples Component
 * 
 * A reusable component for displaying prompt suggestions/follow-ups.
 * Used by ASK tool, COMPLETE tool, and inline message rendering.
 * Matches the frontend design: clean list with dividers and press states.
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronRight } from 'lucide-react-native';
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
      className="active:opacity-70"
    >
      <View className="flex-row items-center justify-between gap-4 py-4">
        <Text 
          className="text-sm font-roobert-medium text-neutral-900 dark:text-neutral-50 flex-1"
          numberOfLines={3}
        >
          {prompt.text}
        </Text>
        <Animated.View style={iconAnimatedStyle}>
          <Icon 
            as={ChevronRight} 
            size={20} 
            className="text-neutral-900 dark:text-neutral-50 opacity-70 flex-shrink-0" 
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
 * - Clean list style with dividers between items
 * - ChevronRight icon that animates on interaction
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
        <Text className="text-base font-roobert-medium text-neutral-900 dark:text-neutral-50 opacity-50 mb-2">
          {title}
        </Text>
      )}
      <View className="overflow-hidden">
        {normalizedPrompts.map((prompt, index) => (
          <React.Fragment key={`prompt-${index}-${prompt.text.substring(0, 20)}`}>
            <PromptItem
              prompt={prompt}
              index={index}
              onPress={() => onPromptClick?.(prompt.text)}
            />
            {index < normalizedPrompts.length - 1 && (
              <View className="h-[1px] bg-neutral-200 dark:bg-neutral-800" />
            )}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

export default PromptExamples;
