import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock, RotateCcw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface VersionBannerProps {
  versionDate?: string;
  onReturnToCurrent: () => void;
}

export function VersionBanner({ versionDate, onReturnToCurrent }: VersionBannerProps) {
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onReturnToCurrent();
  };

  const formattedDate = versionDate
    ? new Date(versionDate).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    : 'previous snapshot';

  return (
    <View className="px-4 py-2 flex-row items-center justify-between bg-card border-b border-border">
      <View className="flex-row items-center gap-2 flex-1 min-w-0">
        <Icon
          as={Clock}
          size={16}
          className="text-primary"
          strokeWidth={2}
        />
        <Text
          className="text-sm flex-1 min-w-0 text-primary"
          numberOfLines={1}
        >
          Viewing version from {formattedDate}
        </Text>
      </View>

      <Pressable
        onPress={handlePress}
        className="flex-row items-center gap-1.5 px-2 py-1 rounded-lg ml-2 bg-card border border-border"
      >
        <Icon
          as={RotateCcw}
          size={12}
          className="text-primary"
          strokeWidth={2}
        />
        <Text className="text-xs font-roobert-medium text-primary">
          Return to Current
        </Text>
      </Pressable>
    </View>
  );
}








