import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CaretRightIcon as ChevronRight } from '@/lib/icons';
import { useColorScheme } from 'nativewind';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { SandboxFile } from '@/api/types';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { fileIcon } from '@/components/files/file-icons';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Muted foreground: the file-list icon color. */
const mutedIconColor = (isDark: boolean) => (isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground);

interface FileItemProps {
  file: SandboxFile;
  onPress: (file: SandboxFile) => void;
  onLongPress?: (file: SandboxFile) => void;
}

/**
 * File Item Component. Memoized: file lists re-render every row otherwise.
 */
export const FileItem = React.memo(function FileItem({ file, onPress, onLongPress }: FileItemProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress(file);
  };

  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onLongPress?.(file);
  };

  const icon = fileIcon(file.name, { isOpen: file.type === 'directory' });

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={animatedStyle}
      className="flex-row items-center justify-between active:opacity-70 py-2"
      accessibilityRole="button"
      accessibilityLabel={file.type === 'directory' ? `Folder ${file.name}` : `File ${file.name}`}
    >
      {/* Left: Icon + Text */}
      <View className="flex-row items-center gap-3 flex-1 min-w-0">
        {/* Icon — monochrome, matches web file-icon (no background container) */}
        <View className="w-6 items-center justify-center flex-shrink-0">
          <Icon
            as={icon}
            size={22}
            color={mutedIconColor(isDark)}
          />
        </View>

        {/* Text Content */}
        <View className="flex-1 min-w-0">
          <Text
            style={{ color: isDark ? THEME.dark.foreground : THEME.light.foreground }}
            className="text-base font-roobert-medium"
            numberOfLines={1}
          >
            {file.name}
          </Text>
          {file.type === 'directory' && (
            <Text
              style={{ color: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.5) }}
              className="text-xs font-roobert mt-0.5"
            >
              Folder
            </Text>
          )}
        </View>
      </View>

      {/* Right: Chevron */}
      <Icon
        as={ChevronRight}
        size={20}
        color={withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.3)}
        className="flex-shrink-0"
      />
    </AnimatedPressable>
  );
});
