import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Loader2 } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { getToolIcon, getToolDisplayName } from '@/lib/utils/tool-display';
import { useColorScheme } from 'nativewind';

interface ToolCallItemProps {
  /** The tool name (e.g., 'execute-command') */
  toolName: string;
  /** Whether the tool execution is complete */
  isComplete: boolean;
  /** Whether the tool is currently processing */
  isProcessing: boolean;
  /** Optional press handler (only works when complete) */
  onPress?: () => void;
}

const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * ToolCallItem - Unified tool call display component
 * 
 * Displays a single tool call with:
 * - Tool-specific icon (or spinner when processing)
 * - Correct tense ("Executing" vs "Executed")
 * - Background when complete, no background when processing
 * - Clickable when complete, disabled when processing
 * 
 * Matches Figma design:
 * - 16px border radius
 * - 12px padding
 * - 8px gap between icon and text
 * - rgba(229,229,229,0.4) background (light mode)
 * - 80% text opacity
 */
export const ToolCallItem = React.memo(function ToolCallItem({
  toolName,
  isComplete,
  isProcessing,
  onPress,
}: ToolCallItemProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const rotation = useSharedValue(0);
  const scale = useSharedValue(1);

  // Get tool-specific icon and display name
  const ToolIcon = getToolIcon(toolName);
  const displayName = getToolDisplayName(toolName, isComplete);

  // Animate spinner rotation when processing
  React.useEffect(() => {
    if (isProcessing) {
      rotation.value = withRepeat(
        withTiming(360, { duration: 1000, easing: Easing.linear }),
        -1,
        false
      );
    } else {
      rotation.value = 0;
    }
  }, [isProcessing, rotation]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    if (isComplete && onPress) {
      scale.value = withTiming(0.97, { duration: 100 });
    }
  };

  const handlePressOut = () => {
    if (isComplete && onPress) {
      scale.value = withSpring(1, { damping: 15, stiffness: 400 });
    }
  };

  const handlePress = () => {
    if (isComplete && onPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress();
    }
  };

  // Processing state: No background, not clickable, spinner icon
  if (isProcessing) {
    return (
      <View className="flex-row items-center gap-2 py-2">
        <AnimatedView style={spinStyle} className="w-5 h-5 items-center justify-center">
          <Icon
            as={Loader2}
            size={20}
            className="text-neutral-900 dark:text-neutral-50"
            strokeWidth={2}
          />
        </AnimatedView>
        <Text 
          className="text-base font-roobert-medium text-neutral-900 dark:text-neutral-50"
          style={{ opacity: 0.8 }}
        >
          {displayName}
        </Text>
      </View>
    );
  }

  // Complete state: Background, clickable, tool-specific icon
  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={!isComplete || !onPress}
      style={[
        scaleStyle,
        {
          backgroundColor: isDark 
            ? 'rgba(64, 64, 64, 0.4)'  // neutral-700/40
            : 'rgba(229, 229, 229, 0.4)', // neutral-200/40
          borderRadius: 16,
          paddingVertical: 12,
          paddingHorizontal: 12,
        },
      ]}
      className="flex-row items-center"
    >
      <View className="w-5 h-5 items-center justify-center mr-2">
        <Icon
          as={ToolIcon}
          size={20}
          className="text-neutral-900 dark:text-neutral-50"
          strokeWidth={2}
        />
      </View>
      <Text 
        className="text-base font-roobert-medium text-neutral-900 dark:text-neutral-50"
        style={{ opacity: 0.8 }}
      >
        {displayName}
      </Text>
    </AnimatedPressable>
  );
});

export default ToolCallItem;

