/**
 * File Item Component
 * Reusable file/folder item with beautiful animations
 * Matches SelectableListItem design pattern from AgentDrawer
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  Folder, 
  File, 
  FileText, 
  FileImage, 
  FileCode,
  FileSpreadsheet,
  ChevronRight,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { SandboxFile } from '@/api/types';
import { FilePreviewType, getFilePreviewType } from './FilePreviewRenderers';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Helper to format file size
function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

interface FileItemProps {
  file: SandboxFile;
  onPress: (file: SandboxFile) => void;
  onLongPress?: (file: SandboxFile) => void;
}

/**
 * Get appropriate icon for file type
 */
function getFileIcon(file: SandboxFile): typeof File {
  if (file.type === 'directory') {
    return Folder;
  }
  
  const previewType = getFilePreviewType(file.name);
  
  switch (previewType) {
    case FilePreviewType.IMAGE:
      return FileImage;
    case FilePreviewType.PDF:
    case FilePreviewType.MARKDOWN:
    case FilePreviewType.TEXT:
      return FileText;
    case FilePreviewType.CSV:
    case FilePreviewType.XLSX:
      return FileSpreadsheet;
    case FilePreviewType.JSON:
    case FilePreviewType.CODE:
    case FilePreviewType.HTML:
      return FileCode;
    default:
      return File;
  }
}

/**
 * Get icon color for file type
 */
function getIconColor(file: SandboxFile, isDark: boolean): string {
  if (file.type === 'directory') {
    return '#3b82f6'; // blue-500
  }
  
  const previewType = getFilePreviewType(file.name);
  
  switch (previewType) {
    case FilePreviewType.IMAGE:
      return '#10b981'; // green-500
    case FilePreviewType.PDF:
      return '#ef4444'; // red-500
    case FilePreviewType.MARKDOWN:
    case FilePreviewType.TEXT:
      return '#8b5cf6'; // violet-500
    case FilePreviewType.CSV:
    case FilePreviewType.XLSX:
      return '#22c55e'; // green-500
    case FilePreviewType.JSON:
    case FilePreviewType.CODE:
    case FilePreviewType.HTML:
      return '#f59e0b'; // amber-500
    default:
      return isDark ? '#a1a1aa' : '#71717a'; // zinc-400/500
  }
}

/**
 * File Item Component
 */
export function FileItem({ file, onPress, onLongPress }: FileItemProps) {
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

  const IconComponent = getFileIcon(file);
  const iconColor = getIconColor(file, isDark);
  const fileSize = file.type === 'directory' ? undefined : formatFileSize(file.size);

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
      className="flex-row items-center justify-between active:opacity-70 mb-2"
      accessibilityRole="button"
      accessibilityLabel={file.type === 'directory' ? `Folder ${file.name}` : `File ${file.name}`}
    >
      {/* Left: Icon + Text */}
      <View className="flex-row items-center gap-3 flex-1 min-w-0">
        {/* Icon Container - 48x48 matching avatar size */}
        <View
          style={{
            backgroundColor: isDark ? '#232324' : '#f4f4f5',
            width: 48,
            height: 48,
          }}
          className="rounded-xl items-center justify-center flex-shrink-0"
        >
          <Icon 
            as={IconComponent} 
            size={20} 
            color={iconColor}
            strokeWidth={2}
          />
        </View>

        {/* Text Content */}
        <View className="flex-1 min-w-0">
          <Text
            style={{ color: isDark ? '#f8f8f8' : '#121215' }}
            className="text-base font-roobert-medium"
            numberOfLines={1}
          >
            {file.name}
          </Text>
          {fileSize && (
            <Text
              style={{ color: isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
              className="text-xs font-roobert mt-0.5"
              numberOfLines={1}
            >
              {fileSize}
            </Text>
          )}
          {file.type === 'directory' && (
            <Text
              style={{ color: isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
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
        color={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)'}
        strokeWidth={2}
        className="flex-shrink-0"
      />
    </AnimatedPressable>
  );
}

