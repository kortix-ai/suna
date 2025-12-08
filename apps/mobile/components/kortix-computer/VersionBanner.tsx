import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock, RotateCcw } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';

interface VersionBannerProps {
  versionDate?: string;
  onReturnToCurrent: () => void;
}

export function VersionBanner({ versionDate, onReturnToCurrent }: VersionBannerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

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
    <View
      className="px-4 py-2 flex-row items-center justify-between"
      style={{
        backgroundColor: isDark ? 'rgba(251, 191, 36, 0.1)' : 'rgba(251, 191, 36, 0.15)',
        borderBottomWidth: 1,
        borderBottomColor: isDark ? 'rgba(251, 191, 36, 0.2)' : 'rgba(251, 191, 36, 0.3)',
      }}
    >
      <View className="flex-row items-center gap-2 flex-1 min-w-0">
        <Icon
          as={Clock}
          size={16}
          color={isDark ? '#fbbf24' : '#d97706'}
          strokeWidth={2}
        />
        <Text 
          className="text-sm flex-1 min-w-0"
          style={{ color: isDark ? '#fbbf24' : '#d97706' }}
          numberOfLines={1}
        >
          Viewing version from {formattedDate}
        </Text>
      </View>

      <Pressable
        onPress={handlePress}
        className="flex-row items-center gap-1.5 px-2 py-1 rounded-lg ml-2"
        style={{
          backgroundColor: isDark ? 'rgba(251, 191, 36, 0.2)' : 'rgba(251, 191, 36, 0.3)',
        }}
      >
        <Icon
          as={RotateCcw}
          size={12}
          color={isDark ? '#fbbf24' : '#d97706'}
          strokeWidth={2}
        />
        <Text
          className="text-xs font-roobert-medium"
          style={{ color: isDark ? '#fbbf24' : '#d97706' }}
        >
          Return to Current
        </Text>
      </Pressable>
    </View>
  );
}




