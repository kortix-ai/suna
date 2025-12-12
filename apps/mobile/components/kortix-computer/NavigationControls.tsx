import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  const insets = useSafeAreaInsets();

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
    const baseClasses = "flex-row items-center justify-center gap-1.5 px-3 h-9 rounded-2xl min-w-[116px] bg-card border border-border";
    const textClasses = "text-xs font-roobert-medium text-primary";

    if (isLiveMode) {
      if (agentStatus === 'running') {
        return (
          <Button
            onPress={handleJumpToLive}
            variant="outline"
            size="sm"
            className={baseClasses}
          >
            <Text className={textClasses}>
              Live Updates
            </Text>
          </Button>
        );
      } else {
        return (
          <Button
            variant="outline"
            size="sm"
            className={baseClasses}
            disabled
          >
            <Text className="text-xs font-roobert-medium text-primary opacity-50">
              Latest Tool
            </Text>
          </Button>
        );
      }
    } else {
      if (agentStatus === 'running') {
        return (
          <Button
            onPress={handleJumpToLive}
            variant="outline"
            size="sm"
            className={baseClasses}
          >
            <Text className={textClasses}>
              Jump to Live
            </Text>
          </Button>
        );
      } else {
        return (
          <Button
            onPress={handleJumpToLatest}
            variant="outline"
            size="sm"
            className={baseClasses}
          >
            <Text className={textClasses}>
              Jump to Latest
            </Text>
          </Button>
        );
      }
    }
  };

  return (
    <View
      className="px-4 pt-4 border-t border-border bg-card"
      style={{ paddingBottom: Math.max(24, insets.bottom + 8) }}
    >
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onPress={handlePrevious}
            disabled={displayIndex <= 0}
            className={`h-9 w-9 p-0 bg-card border border-border rounded-xl ${displayIndex <= 0 ? 'opacity-50' : ''}`}
          >
            <Icon
              as={ChevronLeft}
              size={17}
              className="text-primary"
              strokeWidth={2}
            />
          </Button>
          <View className="w-14">
            <Text className="text-sm font-roobert-semibold tabular-nums text-center text-primary">
              {displayIndex + 1}/{displayTotalCalls}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleNext}
            disabled={safeInternalIndex >= latestIndex}
            className={`h-9 w-9 p-0 bg-card border border-border rounded-xl ${safeInternalIndex >= latestIndex ? 'opacity-50' : ''}`}
          >
            <Icon
              as={ChevronRight}
              size={17}
              className="text-primary"
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

