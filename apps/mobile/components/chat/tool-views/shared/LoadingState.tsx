import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Loader2, LucideIcon } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Animated, { useAnimatedStyle, withTiming, useSharedValue } from 'react-native-reanimated';

interface LoadingStateProps {
  icon?: LucideIcon;
  iconColor?: string;
  bgColor?: string;
  title: string;
  subtitle?: string;
  filePath?: string | null;
  showProgress?: boolean;
  progressText?: string;
  autoProgress?: boolean;
  initialProgress?: number;
}

export function LoadingState({
  icon: Icon = Loader2,
  iconColor = 'text-purple-500 dark:text-purple-400',
  bgColor = 'bg-gradient-to-b from-purple-100 to-purple-50 shadow-inner dark:from-purple-800/40 dark:to-purple-900/60',
  title,
  subtitle,
  filePath,
  showProgress = true,
  progressText,
  autoProgress = true,
  initialProgress = 0,
}: LoadingStateProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [progress, setProgress] = useState(initialProgress);
  const progressValue = useSharedValue(initialProgress);

  useEffect(() => {
    if (showProgress && autoProgress) {
      setProgress(0);
      progressValue.value = 0;
      const timer = setInterval(() => {
        setProgress((prevProgress) => {
          const newProgress = prevProgress >= 95 ? prevProgress : prevProgress + Math.random() * 10 + 5;
          progressValue.value = Math.min(newProgress, 100);
          return newProgress;
        });
      }, 500);
      return () => clearInterval(timer);
    }
  }, [showProgress, autoProgress]);

  const progressStyle = useAnimatedStyle(() => ({
    width: `${Math.min(progressValue.value, 100)}%`,
  }));

  return (
    <View className="flex-1 items-center justify-center py-12 px-6 min-h-[400px]">
      <View className="w-full max-w-sm">
        <View
          className={`w-16 h-16 rounded-full mx-auto mb-6 items-center justify-center ${bgColor}`}
        >
          {Icon === Loader2 ? (
            <KortixLoader size="large" />
          ) : (
            <Icon size={32} color={isDark ? '#a855f7' : '#9333ea'} />
          )}
        </View>

        <Text className="text-xl font-roobert-semibold mb-4 text-center text-foreground">
          {title}
        </Text>

        {filePath && (
          <View className="bg-muted border border-border rounded-xl p-4 w-full mb-6">
            <Text className="text-sm font-roobert-mono text-foreground/80 text-center" numberOfLines={3}>
              {filePath}
            </Text>
          </View>
        )}

        {showProgress && (
          <View className="gap-3">
            <View className="h-1 bg-muted rounded-full overflow-hidden">
              <Animated.View
                className="h-full bg-primary rounded-full"
                style={progressStyle}
              />
            </View>
            <View className="flex-row justify-between items-center">
              <Text className="text-xs text-muted-foreground">
                {progressText || 'Processing...'}
              </Text>
              <Text className="text-xs font-roobert-mono text-muted-foreground">
                {Math.round(Math.min(progress, 100))}%
              </Text>
            </View>
          </View>
        )}

        {subtitle && (
          <Text className="text-sm text-muted-foreground mt-4 text-center">
            {subtitle}
          </Text>
        )}
      </View>
    </View>
  );
}

