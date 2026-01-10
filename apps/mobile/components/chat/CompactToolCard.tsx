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
      };
    }

    return {
      toolName: parsed.toolName,
      displayName: getUserFriendlyToolName(parsed.toolName),
      isError: !parsed.result.success,
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

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={!onPress}
      className="w-full flex-row items-center gap-1 rounded-full"
    >
      <View className="w-5 h-5 rounded-md items-center justify-center">
        <Icon
          as={isError ? AlertCircle : IconComponent}
          size={16}
          className={isError ? 'text-destructive' : 'text-muted-foreground'}
        />
      </View>
      
      <Text className="text-sm font-roobert-medium text-muted-foreground" numberOfLines={1}>
        {displayName}
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

  const resolvedToolName = toolName || toolCall?.function_name || (toolCall as any)?.name || '';
  const displayName = resolvedToolName ? getUserFriendlyToolName(resolvedToolName) : 'Running...';
  const IconComponent = resolvedToolName ? getToolIcon(resolvedToolName) : CircleDashed;

  const cardContent = (
    <View className="w-full flex-row items-center rounded-full">
      {isCompleted ? (
        <>
          <View className="w-5 h-5 rounded-md items-center justify-center">
            <Icon as={IconComponent} size={16} className="text-muted-foreground" />
          </View>
          <Text className="text-sm font-roobert-medium text-muted-foreground ml-1" numberOfLines={1}>
            {displayName}
          </Text>
          <Icon as={CheckCircle2} size={12} className="text-emerald-500 ml-2" />
        </>
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
