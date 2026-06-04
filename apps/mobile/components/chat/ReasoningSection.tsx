/**
 * ReasoningSection component for displaying AI reasoning/thinking content
 * Adapted from frontend design with React Native animations
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { View, Pressable, LayoutAnimation, Platform, UIManager, TextStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
  interpolate,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { ChevronDown } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { cn } from '@/lib/utils/utils';
import { ShimmerText } from '@/components/ui/ShimmerText';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface ReasoningSectionProps {
  content: string;
  isStreaming?: boolean;
  /** Whether reasoning is actively being generated (for shimmer effect) */
  isReasoningActive?: boolean;
  /** Whether reasoning generation is complete */
  isReasoningComplete?: boolean;
  /** Whether this is persisted content (from server) vs streaming content */
  isPersistedContent?: boolean;
  /** Controlled mode: external expanded state */
  isExpanded?: boolean;
  /** Controlled mode: callback when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void;
  /** Visual density variant */
  variant?: 'default' | 'compact';
}

export function ReasoningSection({
  content,
  isStreaming = false,
  isReasoningActive = false,
  isReasoningComplete = false,
  isPersistedContent = false,
  isExpanded: controlledExpanded,
  onExpandedChange,
  variant = 'default',
}: ReasoningSectionProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isCompact = variant === 'compact';
  const contentStyle = useMemo<TextStyle>(() => ({
    fontSize: isCompact ? 12 : 13,
    lineHeight: isCompact ? 18 : 22,
    color: isDark ? 'rgba(248,248,248,0.55)' : 'rgba(18,18,21,0.55)',
    fontFamily: 'Roobert-Regular',
  }), [isCompact, isDark]);
  const placeholderStyle = useMemo<TextStyle>(() => ({
    fontSize: isCompact ? 12 : 13,
    lineHeight: isCompact ? 18 : 20,
    color: isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)',
    fontFamily: 'Roobert-Regular',
  }), [isCompact, isDark]);

  // Support both controlled and uncontrolled modes - start collapsed by default
  const [internalExpanded, setInternalExpanded] = useState(false);

  // Use controlled mode if external state is provided
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : internalExpanded;
  const setIsExpanded = (expanded: boolean) => {
    if (isControlled && onExpandedChange) {
      onExpandedChange(expanded);
    } else {
      setInternalExpanded(expanded);
    }
  };

  // Determine if shimmer should be active (reasoning is being generated and not complete)
  const shouldShimmer = (isReasoningActive || isStreaming) && !isReasoningComplete;

  const hasContent = content && content.trim().length > 0;

  // Use ref to preserve already-rendered content and avoid re-animation on toggle
  const committedContentRef = useRef<string>('');
  const lastContentLengthRef = useRef<number>(0);

  // Update committed content when new content arrives
  useEffect(() => {
    if (content && content.length > lastContentLengthRef.current) {
      committedContentRef.current = content;
      lastContentLengthRef.current = content.length;
    }
    // Reset refs when content is cleared (new stream starting)
    if (!content || content.length === 0) {
      committedContentRef.current = '';
      lastContentLengthRef.current = 0;
    }
  }, [content]);

  // Use committed content for display - ensures toggle doesn't cause re-animation
  const displayContent = committedContentRef.current || content;

  // Chevron rotation animation
  const chevronRotation = useSharedValue(0);
  useEffect(() => {
    chevronRotation.value = withTiming(isExpanded ? 180 : 0, {
      duration: 200,
      easing: Easing.inOut(Easing.ease),
    });
  }, [isExpanded]);

  const chevronAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value}deg` }],
  }));

  // No custom shimmer animation — we use the shared ShimmerText component instead

  const handleToggle = () => {
    // Configure layout animation for smooth expand/collapse
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsExpanded(!isExpanded);
  };

  return (
    <Animated.View
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(150)}
      className="w-full"
      style={{ marginBottom: isExpanded ? 4 : 0 }}
    >
      {/* Header row: Kortix logo + Toggle button */}
      <View className="flex-row items-center gap-1">
        <Pressable
          onPress={handleToggle}
          className="flex-row items-center gap-1 py-0.5"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          {shouldShimmer ? (
            <ShimmerText text={isExpanded ? 'Hide Reasoning' : 'Show Reasoning'} size="xs" />
          ) : (
            <Text className="font-roobert-medium text-[13px] text-muted-foreground/80">
              {isExpanded ? 'Hide Reasoning' : 'Show Reasoning'}
            </Text>
          )}
          <Animated.View style={chevronAnimatedStyle}>
            <Icon
              as={ChevronDown}
              size={16}
              className="text-muted-foreground"
            />
          </Animated.View>
        </Pressable>
      </View>

      {/* Expandable content with left border */}
      {isExpanded && (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          className={cn('mt-1 pl-4', 'ml-0')}
          style={{
            borderLeftWidth: 2,
            borderLeftColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
          }}
        >
          {hasContent ? (
            <SelectableMarkdownText
              isDark={isDark}
              style={contentStyle}
            >
              {displayContent}
            </SelectableMarkdownText>
          ) : (
            <Text
              className="text-sm"
              style={placeholderStyle}
            >
              Waiting for reasoning content...
            </Text>
          )}
        </Animated.View>
      )}
    </Animated.View>
  );
}

export default ReasoningSection;
