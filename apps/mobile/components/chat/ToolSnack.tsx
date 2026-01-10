import React, { useEffect } from 'react';
import { View, Pressable, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Maximize2 } from 'lucide-react-native';
import { getToolIcon } from '@/lib/icons/tool-icons';
import { getUserFriendlyToolName, parseToolMessage, type ParsedToolData } from '@agentpress/shared';
import { useColorScheme } from 'nativewind';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import LottieView from 'lottie-react-native';
import type { UnifiedMessage } from '@agentpress/shared';
import * as Haptics from 'expo-haptics';
import { log } from '@/lib/logger';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.3; // 30% of screen width to dismiss

interface ToolSnackProps {
  /** The current/last tool data to display (from tool message) */
  toolData: ToolSnackData | null;
  /** Whether the agent is currently running (affects status text) */
  isAgentRunning: boolean;
  /** Agent name for "Agent is working..." text */
  agentName?: string;
  /** Callback when tapping the snack to expand */
  onPress?: () => void;
  /** Callback when user swipes to dismiss */
  onDismiss?: () => void;
}

export interface ToolSnackData {
  toolName: string;
  functionName: string;
  success: boolean;
  toolCallId?: string;
  isStreaming?: boolean;
}

/**
 * Extract the last visible tool from an array of messages.
 * Looks at TOOL type messages and parses them using parseToolMessage.
 * Filters out ask/complete tools which render as text, not snack.
 */
export function extractLastToolFromMessages(messages: UnifiedMessage[]): ToolSnackData | null {
  // Iterate from end to find the last tool message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === 'tool') {
      const parsed = parseToolMessage(msg);

      if (parsed) {
        const toolName = parsed.toolName.toLowerCase();
        // Skip ask/complete tools
        if (toolName.includes('ask') || toolName.includes('complete')) {
          continue;
        }

        return {
          toolName: parsed.toolName,
          functionName: parsed.functionName,
          success: parsed.result.success,
          toolCallId: parsed.toolCallId,
          isStreaming: false,
        };
      }
    }
  }
  return null;
}

/**
 * Extract tool data from a streaming tool call message.
 * Looks at assistant message metadata for tool_calls array.
 */
export function extractToolFromStreamingMessage(message: UnifiedMessage | null): ToolSnackData | null {
  if (!message) {
    return null;
  }


  try {
    const metadata = JSON.parse(message.metadata || '{}');
    const toolCalls = metadata.tool_calls || [];

    // Filter out ask/complete tools and get the last visible one
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const tc = toolCalls[i];
      const name = (tc.function_name || tc.name || '').toLowerCase();

      if (name.includes('ask') || name.includes('complete')) {
        continue;
      }
      return {
        toolName: (tc.function_name || tc.name || 'Tool').replace(/_/g, '-'),
        functionName: tc.function_name || tc.name || 'Tool',
        success: tc.tool_result?.success !== false,
        toolCallId: tc.tool_call_id,
        isStreaming: !tc.completed && !tc.tool_result,
      };
    }
  } catch (e) {
    log.log('[extractStreamingTool] Error parsing metadata:', e);
  }

  return null;
}

export const ToolSnack = React.memo(function ToolSnack({
  toolData,
  isAgentRunning,
  agentName = 'Suna',
  onPress,
  onDismiss,
}: ToolSnackProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Animation values
  const translateY = useSharedValue(20);
  const translateX = useSharedValue(0);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.95);

  // Snack is visible whenever we have tool data to show (persisted by parent)
  const isVisible = !!toolData;

  // Debug logging
  const toolName = toolData?.toolName || 'Tool';
  const displayName = getUserFriendlyToolName(toolName);
  const ToolIcon = getToolIcon(toolName);

  // Determine status - if streaming, show as in progress
  const isStreaming = toolData?.isStreaming ?? false;
  const isSuccess = toolData?.success ?? true;

  // Haptic feedback helper
  const triggerHaptic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Dismiss handler
  const handleDismiss = () => {
    triggerHaptic();
    onDismiss?.();
  };

  // Pan gesture for swipe to dismiss
  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10]) // Start detecting after 10px horizontal movement
    .onUpdate((event) => {
      translateX.value = event.translationX;
      // Fade out as user swipes
      const progress = Math.abs(event.translationX) / SWIPE_THRESHOLD;
      opacity.value = Math.max(0.3, 1 - progress * 0.7);
    })
    .onEnd((event) => {
      const shouldDismiss = Math.abs(event.translationX) > SWIPE_THRESHOLD;

      if (shouldDismiss) {
        // Animate out in swipe direction
        const direction = event.translationX > 0 ? 1 : -1;
        translateX.value = withTiming(direction * SCREEN_WIDTH, { duration: 200 });
        opacity.value = withTiming(0, { duration: 200 });
        runOnJS(handleDismiss)();
      } else {
        // Snap back
        translateX.value = withSpring(0, { damping: 20, stiffness: 300 });
        opacity.value = withSpring(1, { damping: 20, stiffness: 300 });
      }
    });

  // Animate in/out
  useEffect(() => {
    if (isVisible) {
      // Reset horizontal position when becoming visible
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

  // Don't render if not visible
  if (!toolData) {
    return null;
  }

  // Status colors
  const statusBgColor = isStreaming
    ? 'rgba(59, 130, 246, 0.1)' // blue
    : isSuccess
      ? 'rgba(34, 197, 94, 0.1)' // green
      : 'rgba(239, 68, 68, 0.1)'; // red

  const statusDotColor = isStreaming
    ? '#3B82F6'
    : isSuccess
      ? '#22C55E'
      : '#EF4444';

  const statusTextColor = isStreaming
    ? '#3B82F6'
    : isSuccess
      ? '#22C55E'
      : '#EF4444';

  const statusText = isStreaming
    ? `${agentName} is working...`
    : isSuccess
      ? 'Success'
      : 'Failed';

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View style={animatedStyle} className="mx-3 mb-2">
        <Pressable
          onPress={onPress}
          className="flex-row items-center gap-3 rounded-3xl p-2 border border-border bg-card active:opacity-80"
        >
          {/* Tool Icon */}
          <View
            className="w-10 h-10 rounded-2xl items-center justify-center"
            style={{
              backgroundColor: isDark ? 'rgba(113, 113, 122, 0.2)' : 'rgba(113, 113, 122, 0.1)',
            }}
          >
            {isStreaming ? (
              <LottieView
                source={require('@/components/animations/loading.json')}
                style={{ width: 24, height: 24 }}
                autoPlay
                loop
                speed={1.2}
                colorFilters={[
                  {
                    keypath: '*',
                    color: isDark ? '#a1a1aa' : '#71717a',
                  },
                ]}
              />
            ) : (
              <Icon as={ToolIcon} size={20} className="text-muted-foreground" />
            )}
          </View>

          {/* Tool Info */}
          <View className="flex-1 min-w-0">
            <Text
              className="text-sm font-roobert-medium text-foreground"
              numberOfLines={1}
            >
              {displayName}
            </Text>
          </View>

          {/* Status Badge */}
          <View
            className="flex-row items-center gap-1.5 px-2 py-1 rounded-full"
            style={{ backgroundColor: statusBgColor }}
          >
            <View
              key={isStreaming ? 'streaming' : 'static'}
              className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: statusDotColor }}
            />
            <Text
              className="text-xs font-roobert-medium"
              style={{ color: statusTextColor }}
              numberOfLines={1}
            >
              {statusText}
            </Text>
          </View>

          {/* Expand Icon */}
          <View className="pr-1">
            <Icon as={Maximize2} size={16} className="text-muted-foreground" />
          </View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
});

