import React, { useState, useEffect } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Search, Check, Circle } from 'lucide-react-native';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useColorScheme } from 'nativewind';
import Animated, {
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  useSharedValue,
  interpolate,
  Easing,
  FadeIn,
  FadeInDown,
  SlideInRight,
} from 'react-native-reanimated';

interface DeepSearchLoadingStateProps {
  queries: string[];
}

function QueryRow({ 
  query, 
  index, 
  isActive,
  isCompleted,
}: { 
  query: string; 
  index: number; 
  isActive: boolean;
  isCompleted: boolean;
}) {
  const pulseAnim = useSharedValue(0);
  
  useEffect(() => {
    if (isActive) {
      pulseAnim.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.4, { duration: 800, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        false
      );
    } else {
      pulseAnim.value = withTiming(isCompleted ? 1 : 0.4, { duration: 200 });
    }
  }, [isActive, isCompleted]);

  const opacityStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pulseAnim.value, [0, 1], [0.5, 1]),
  }));

  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: isActive ? interpolate(pulseAnim.value, [0.4, 1], [0.9, 1.1]) : 1 }],
  }));

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 60).duration(300)}
      style={opacityStyle}
      className="flex-row items-start gap-3 py-2"
    >
      {/* Status dot */}
      <View className="pt-0.5">
        {isCompleted ? (
          <View className="w-5 h-5 rounded-full bg-emerald-500/20 items-center justify-center">
            <Icon as={Check} size={12} className="text-emerald-500" />
          </View>
        ) : isActive ? (
          <Animated.View 
            style={dotStyle}
            className="w-5 h-5 rounded-full bg-primary/20 items-center justify-center"
          >
            <KortixLoader size="small" customSize={12} />
          </Animated.View>
        ) : (
          <View className="w-5 h-5 rounded-full bg-muted items-center justify-center">
            <Icon as={Circle} size={8} className="text-muted-foreground/50" />
          </View>
        )}
      </View>

      {/* Query text */}
      <Text 
        className={`flex-1 text-sm leading-5 ${
          isActive 
            ? 'text-foreground font-roobert-medium' 
            : isCompleted
              ? 'text-foreground/80'
              : 'text-muted-foreground'
        }`}
        numberOfLines={2}
      >
        {query}
      </Text>
    </Animated.View>
  );
}

export function DeepSearchLoadingState({ queries }: DeepSearchLoadingStateProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const [activeIndex, setActiveIndex] = useState(0);
  const [completedIndices, setCompletedIndices] = useState<Set<number>>(new Set());
  
  const progressValue = useSharedValue(0);
  const glowAnim = useSharedValue(0);

  // Parse queries - handle various formats
  const parsedQueries = React.useMemo(() => {
    if (!queries) return [];
    if (Array.isArray(queries)) {
      return queries.filter(q => typeof q === 'string' && q.trim().length > 0);
    }
    if (typeof queries === 'string') {
      try {
        const parsed = JSON.parse(queries);
        if (Array.isArray(parsed)) {
          return parsed.filter(q => typeof q === 'string' && q.trim().length > 0);
        }
        return [queries];
      } catch {
        return [queries];
      }
    }
    return [];
  }, [queries]);

  useEffect(() => {
    if (parsedQueries.length === 0) return;

    // Glow animation
    glowAnim.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );

    // Progress animation
    progressValue.value = withTiming(95, { 
      duration: parsedQueries.length * 2000, 
      easing: Easing.out(Easing.quad) 
    });

    // Cycle through queries
    const interval = setInterval(() => {
      setActiveIndex((prev) => {
        if (prev < parsedQueries.length - 1) {
          setCompletedIndices((completed) => new Set([...completed, prev]));
          return prev + 1;
        }
        return prev;
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [parsedQueries.length]);

  const progressStyle = useAnimatedStyle(() => ({
    width: `${progressValue.value}%`,
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(glowAnim.value, [0, 1], [0.3, 0.8]),
  }));

  if (parsedQueries.length === 0) {
    return null;
  }

  const completedCount = completedIndices.size;
  const progressPercent = Math.round((completedCount / parsedQueries.length) * 100);

  return (
    <View className="flex-1 px-4 py-5">
      {/* Header */}
      <Animated.View 
        entering={FadeIn.duration(300)}
        className="flex-row items-center gap-3 mb-5"
      >
        {/* Animated icon */}
        <View className="relative">
          <Animated.View 
            style={glowStyle}
            className="absolute -inset-1 rounded-full bg-primary/30"
          />
          <View className="w-10 h-10 rounded-full bg-primary/15 border border-primary/25 items-center justify-center">
            <Icon as={Search} size={18} className="text-primary" />
          </View>
        </View>
        
        <View className="flex-1">
          <Text className="text-base font-roobert-semibold text-foreground">
            Deep Research
          </Text>
          <Text className="text-xs text-muted-foreground mt-0.5">
            {completedCount} of {parsedQueries.length} queries completed
          </Text>
        </View>

        {/* Percentage */}
        <View className="bg-primary/10 px-2.5 py-1 rounded-full">
          <Text className="text-xs font-roobert-mono font-medium text-primary">
            {progressPercent}%
          </Text>
        </View>
      </Animated.View>

      {/* Progress bar */}
      <View className="h-1 bg-muted rounded-full overflow-hidden mb-5">
        <Animated.View
          style={progressStyle}
          className="h-full bg-primary rounded-full"
        />
      </View>

      {/* Queries list */}
      <ScrollView 
        className="flex-1" 
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 8 }}
      >
        <View className="gap-1">
          {parsedQueries.map((query, index) => (
            <QueryRow
              key={index}
              query={query}
              index={index}
              isActive={index === activeIndex}
              isCompleted={completedIndices.has(index)}
            />
          ))}
        </View>
      </ScrollView>

      {/* Footer status */}
      <Animated.View 
        entering={FadeIn.delay(300)}
        className="flex-row items-center justify-center gap-2 pt-4 border-t border-border/50"
      >
        <KortixLoader size="small" customSize={14} />
        <Text className="text-xs text-muted-foreground">
          Analyzing search results...
        </Text>
      </Animated.View>
    </View>
  );
}
