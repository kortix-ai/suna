import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';

interface NavigationControlsProps {
  displayIndex: number;
  displayTotalCalls: number;
  safeInternalIndex: number;
  latestIndex: number;
  isLiveMode: boolean;
  agentStatus: string;
  onPrevious: () => void;
  onNext: () => void;
  onJumpToLive: () => void;
  onJumpToLatest: () => void;
}

export function NavigationControls({
  displayIndex,
  displayTotalCalls,
  safeInternalIndex,
  latestIndex,
  isLiveMode,
  agentStatus,
  onPrevious,
  onNext,
  onJumpToLive,
  onJumpToLatest,
}: NavigationControlsProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const handlePrevious = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPrevious();
  };

  const handleNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onNext();
  };

  const handleJumpToLive = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onJumpToLive();
  };

  const handleJumpToLatest = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onJumpToLatest();
  };

  const renderStatusButton = () => {
    const baseClasses = "flex-row items-center justify-center gap-1.5 px-3 py-1.5 rounded-full min-w-[116px]";
    const dotSize = 6;
    const textClasses = "text-xs font-roobert-medium";

    if (isLiveMode) {
      if (agentStatus === 'running') {
        return (
          <Button
            onPress={handleJumpToLive}
            variant="default"
            size="sm"
            className={`${baseClasses} bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800`}
          >
            <View
              className="rounded-full bg-green-500"
              style={{ width: dotSize, height: dotSize }}
            />
            <Text className={`${textClasses} text-green-700 dark:text-green-400`}>
              Live Updates
            </Text>
          </Button>
        );
      } else {
        return (
          <View className={`${baseClasses} bg-neutral-50 dark:bg-neutral-900/20 border border-neutral-200 dark:border-neutral-800`}>
            <View
              className="rounded-full bg-neutral-500"
              style={{ width: dotSize, height: dotSize }}
            />
            <Text className={`${textClasses} text-neutral-700 dark:text-neutral-400`}>
              Latest Tool
            </Text>
          </View>
        );
      }
    } else {
      if (agentStatus === 'running') {
        return (
          <Button
            onPress={handleJumpToLive}
            variant="default"
            size="sm"
            className={`${baseClasses} bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800`}
          >
            <View
              className="rounded-full bg-green-500"
              style={{ width: dotSize, height: dotSize }}
            />
            <Text className={`${textClasses} text-green-700 dark:text-green-400`}>
              Jump to Live
            </Text>
          </Button>
        );
      } else {
        return (
          <Button
            onPress={handleJumpToLatest}
            variant="default"
            size="sm"
            className={`${baseClasses} bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800`}
          >
            <View
              className="rounded-full bg-blue-500"
              style={{ width: dotSize, height: dotSize }}
            />
            <Text className={`${textClasses} text-blue-700 dark:text-blue-400`}>
              Jump to Latest
            </Text>
          </Button>
        );
      }
    }
  };

  return (
    <View
      className="px-4 py-3 border-t border-border bg-muted/50"
      style={{
        borderTopColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
        backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
      }}
    >
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onPress={handlePrevious}
            disabled={displayIndex <= 0}
            className="h-8 w-8 p-0"
          >
            <Icon
              as={ChevronLeft}
              size={16}
              color={displayIndex <= 0
                ? (isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)')
                : (isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)')
              }
              strokeWidth={2}
            />
          </Button>
          <View className="px-2 min-w-[44px]">
            <Text
              className="text-xs font-roobert-semibold tabular-nums text-center"
              style={{
                color: isDark ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
              }}
            >
              {displayIndex + 1}/{displayTotalCalls}
            </Text>
          </View>
          <Button
            variant="ghost"
            size="sm"
            onPress={handleNext}
            disabled={safeInternalIndex >= latestIndex}
            className="h-8 w-8 p-0"
          >
            <Icon
              as={ChevronRight}
              size={16}
              color={safeInternalIndex >= latestIndex
                ? (isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)')
                : (isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)')
              }
              strokeWidth={2}
            />
          </Button>
        </View>

        <View className="flex-1" />

        <View className="flex-row items-center gap-1.5">
          {renderStatusButton()}
        </View>
      </View>
    </View>
  );
}

