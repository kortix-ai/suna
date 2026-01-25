import React, { useMemo, useEffect, useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, AlertCircle, CircleDashed } from 'lucide-react-native';
import { getToolIcon } from '@/lib/icons/tool-icons';
import { getUserFriendlyToolName, parseToolMessage } from '@agentpress/shared';
import type { UnifiedMessage, ParsedContent } from '@agentpress/shared';
import { useColorScheme } from 'nativewind';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSpring,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';

interface AnimatedPressableProps {
  onPress?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}

const AnimatedPressable = ({ onPress, disabled, children, className }: AnimatedPressableProps) => {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
    opacity.value = withTiming(0.7, { duration: 100 });
  }, []);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
    opacity.value = withTiming(1, { duration: 100 });
  }, []);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
    >
      <Animated.View style={animatedStyle} className={className}>
        {children}
      </Animated.View>
    </Pressable>
  );
};

// Command tools that show command preview
const COMMAND_TOOLS = new Set([
  'execute-command',
  'execute_command',
  'check-command-output',
  'check_command_output',
  'terminate-command',
  'terminate_command',
  'list-commands',
  'list_commands',
]);

/**
 * Extract a field value from partial JSON string during streaming
 */
function extractFieldFromPartialJson(jsonString: string, fieldName: string): string | null {
  if (!jsonString || typeof jsonString !== 'string') return null;

  // Look for the field in the JSON string: "field_name": "value"
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"`, 'i');
  const match = jsonString.match(pattern);

  if (!match || match.index === undefined) return null;

  // Find the start of the value (after the opening quote)
  const valueStart = match.index + match[0].length;
  let value = '';
  let i = valueStart;
  let escaped = false;

  // Parse the string value, handling escape sequences
  while (i < jsonString.length) {
    const char = jsonString[i];

    if (escaped) {
      // Handle escape sequences
      switch (char) {
        case 'n': value += '\n'; break;
        case 't': value += '\t'; break;
        case 'r': value += '\r'; break;
        case '"': value += '"'; break;
        case '\\': value += '\\'; break;
        default: value += char;
      }
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      // End of string value
      break;
    } else {
      value += char;
    }
    i++;
  }

  return value || null;
}

/**
 * Extract command from tool call arguments
 * Handles both complete JSON objects and partial JSON strings during streaming
 */
function extractCommandPreview(toolCall: any): string | null {
  if (!toolCall?.arguments) return null;

  try {
    // If arguments is a string, try to parse it as JSON first
    if (typeof toolCall.arguments === 'string') {
      // Try full JSON parse first
      try {
        const parsed = JSON.parse(toolCall.arguments);
        return parsed?.command || null;
      } catch {
        // If that fails, try extracting from partial JSON (during streaming)
        return extractFieldFromPartialJson(toolCall.arguments, 'command');
      }
    }

    // If it's already an object, just get the command
    return toolCall.arguments?.command || null;
  } catch {
    return null;
  }
}

interface CompactToolCardProps {
  message?: UnifiedMessage;
  isLoading?: boolean;
  toolCall?: ParsedContent;
  onPress?: () => void;
}

interface ShimmerTextProps {
  text: string;
}

const ShimmerText = ({ text }: ShimmerTextProps) => {
  const shimmerPosition = useSharedValue(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  useEffect(() => {
    shimmerPosition.value = withRepeat(
      withTiming(1, { duration: 1000, easing: Easing.linear }),
      -1,
      false
    );
  }, []);

  const animatedGradientStyle = useAnimatedStyle(() => {
    const translateX = interpolate(shimmerPosition.value, [0, 1], [-200, 200]);
    return {
      transform: [{ translateX }],
    };
  });

  const textColor = isDark ? '#a1a1aa' : '#71717a';
  const shimmerColor = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.7)';

  return (
    <MaskedView
      maskElement={
        <Text className="text-sm font-roobert-medium" style={{ color: '#000' }}>{text}</Text>
      }
    >
      <View style={{ width: 160, height: 18 }}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: textColor }]} />
        <Animated.View style={[StyleSheet.absoluteFill, { width: 200 }, animatedGradientStyle]}>
          <LinearGradient
            colors={[textColor, shimmerColor, textColor]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{ flex: 1, width: 200 }}
          />
        </Animated.View>
      </View>
    </MaskedView>
  );
};

export const CompactToolCard = React.memo(function CompactToolCard({
  message,
  isLoading = false,
  toolCall,
  onPress,
}: CompactToolCardProps) {
  const completedData = useMemo(() => {
    if (!message || isLoading) return null;

    const parsed = parseToolMessage(message);
    if (!parsed) {
      return {
        toolName: 'Unknown Tool',
        displayName: 'Unknown Tool',
        isError: true,
        commandPreview: null,
      };
    }

    // Extract command preview for command tools
    const normalizedToolName = parsed.toolName.replace(/_/g, '-');
    const isCommandTool = COMMAND_TOOLS.has(normalizedToolName) || COMMAND_TOOLS.has(parsed.toolName);
    let commandPreview: string | null = null;

    if (isCommandTool && parsed.arguments) {
      if (typeof parsed.arguments === 'string') {
        // Try full JSON parse first, fall back to partial JSON extraction
        try {
          const args = JSON.parse(parsed.arguments);
          commandPreview = args?.command || null;
        } catch {
          commandPreview = extractFieldFromPartialJson(parsed.arguments, 'command');
        }
      } else {
        commandPreview = parsed.arguments?.command || null;
      }
    }

    return {
      toolName: parsed.toolName,
      displayName: getUserFriendlyToolName(parsed.toolName),
      isError: !parsed.result.success,
      commandPreview,
    };
  }, [message, isLoading]);

  const loadingData = useMemo(() => {
    if (!isLoading || !toolCall) return null;

    const toolName = toolCall.function_name || toolCall.name || 'Tool';
    const displayName = getUserFriendlyToolName(toolName);

    return { toolName, displayName };
  }, [isLoading, toolCall]);

  const toolName = isLoading ? loadingData?.toolName : completedData?.toolName;
  const displayName = isLoading ? loadingData?.displayName : completedData?.displayName;
  const IconComponent = toolName ? getToolIcon(toolName) : CircleDashed;
  const isError = completedData?.isError;
  const commandPreview = completedData?.commandPreview;

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={!onPress}
      className="w-full"
    >
      <View className="w-5 h-5 rounded-md items-center justify-center">
        <Icon
          as={isError ? AlertCircle : (isLoading ? IconComponent : CheckCircle2)}
          size={16}
          className={isError ? 'text-rose-500' : 'text-muted-foreground'}
        />
      </View>

      <Text
        className={`text-sm font-roobert-medium ${isError ? 'text-rose-500' : 'text-muted-foreground'}`}
        numberOfLines={1}
      >
        {isError ? `${displayName} failed` : displayName}
      </Text>
    </AnimatedPressable>
  );
});

interface CompactStreamingToolCardProps {
  toolCall: {
    function_name?: string;
    arguments?: Record<string, any> | string;
    completed?: boolean;
    tool_result?: any;
    tool_call_id?: string;
  } | null;
  toolName: string;
  onPress?: () => void;
}

export const CompactStreamingToolCard = React.memo(function CompactStreamingToolCard({
  toolCall,
  toolName,
  onPress,
}: CompactStreamingToolCardProps) {
  const isCompleted = toolCall?.completed === true ||
    (toolCall?.tool_result !== undefined &&
      toolCall?.tool_result !== null &&
      (typeof toolCall.tool_result === 'object' || Boolean(toolCall.tool_result)));

  // Check if tool execution failed
  const isError = useMemo(() => {
    const toolResult = toolCall?.tool_result;
    if (!toolResult || !isCompleted) return false;

    // Check explicit success: false
    if (typeof toolResult === 'object' && toolResult !== null) {
      if (toolResult.success === false) return true;
      if (toolResult.error) return true;
      // Check for error strings in output
      if (typeof toolResult.output === 'string') {
        const output = toolResult.output.toLowerCase();
        if (output.startsWith('error:') || output.includes('failed') || output.includes('exception')) {
          return true;
        }
      }
    }

    // Check if string result indicates error
    if (typeof toolResult === 'string') {
      const result = toolResult.toLowerCase();
      if (result.startsWith('error:') || result.includes('failed') || result.includes('exception')) {
        return true;
      }
    }

    return false;
  }, [toolCall?.tool_result, isCompleted]);

  const resolvedToolName = toolName || toolCall?.function_name || (toolCall as any)?.name || '';
  const normalizedToolName = resolvedToolName.replace(/_/g, '-');
  const displayName = resolvedToolName ? getUserFriendlyToolName(resolvedToolName) : 'Running...';
  const IconComponent = resolvedToolName ? getToolIcon(resolvedToolName) : CircleDashed;

  // Check if this is a command tool and extract command preview
  const isCommandTool = COMMAND_TOOLS.has(normalizedToolName) || COMMAND_TOOLS.has(resolvedToolName);
  const commandPreview = isCommandTool ? extractCommandPreview(toolCall) : null;

  const cardContent = (
    <View className="w-full flex-row items-center rounded-full">
      {isCompleted ? (
        isError ? (
          <>
            <View className="w-5 h-5 rounded-md items-center justify-center">
              <Icon as={AlertCircle} size={16} className="text-rose-500" />
            </View>
            <Text className="text-sm font-roobert-medium text-rose-500 ml-1" numberOfLines={1}>
              {displayName} failed
            </Text>
          </>
        ) : (
          <>
            <View className="w-5 h-5 rounded-md items-center justify-center">
              <Icon as={CheckCircle2} size={16} className="text-muted-foreground" />
            </View>
            <Text className="text-sm font-roobert-medium text-muted-foreground ml-1" numberOfLines={1}>
              {displayName}
            </Text>
          </>
        )
      ) : (
        <>
          <View className="w-5 h-5 rounded-md items-center justify-center">
            <Icon as={IconComponent} size={16} className="text-muted-foreground" />
          </View>
          <View className="ml-1">
            <ShimmerText text={displayName} />
          </View>
        </>
      )}
    </View>
  );

  if (isCompleted && onPress) {
    return (
      <AnimatedPressable onPress={onPress}>
        {cardContent}
      </AnimatedPressable>
    );
  }

  return cardContent;
});
