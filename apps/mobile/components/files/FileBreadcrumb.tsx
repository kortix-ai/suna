/**
 * File Breadcrumb Navigation Component
 * Clean, lean, elegant breadcrumb trail for navigating file paths
 */

import React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CaretRightIcon as ChevronRight, FolderIcon as Folder } from '@/lib/icons';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface BreadcrumbSegment {
  name: string;
  path: string;
  isLast: boolean;
}

interface FileBreadcrumbProps {
  segments: BreadcrumbSegment[];
  onNavigate: (path: string) => void;
}

/**
 * File Breadcrumb Component
 */
export function FileBreadcrumb({ segments, onNavigate }: FileBreadcrumbProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const handlePress = (path: string, isLast: boolean) => {
    if (!isLast) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onNavigate(path);
    }
  };

  return (
    <ScrollView 
      horizontal 
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ 
        flexDirection: 'row', 
        alignItems: 'center',
        paddingHorizontal: 4,
      }}
    >
      {/* Root folder indicator */}
      <Pressable
        onPress={() => handlePress('/workspace', segments.length === 0)}
        disabled={segments.length === 0}
        className="flex-row items-center px-2 py-1 rounded-lg active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel="Workspace"
      >
        <Icon
          as={Folder}
          size={14}
          color={segments.length === 0
            ? (isDark ? THEME.dark.foreground : THEME.light.foreground)
            : withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.4)
          }
        />
      </Pressable>

      {/* Path segments */}
      {segments.map((segment, index) => (
        <React.Fragment key={segment.path}>
          <Icon
            as={ChevronRight}
            size={12}
            color={withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.25)}
            style={{ marginHorizontal: 2 }}
          />
          <Pressable
            onPress={() => handlePress(segment.path, segment.isLast)}
            disabled={segment.isLast}
            className="px-2 py-1 rounded-lg active:opacity-70"
          >
            <Text
              style={{
                color: segment.isLast
                  ? (isDark ? THEME.dark.foreground : THEME.light.foreground)
                  : withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.5),
              }}
              className={`text-sm ${segment.isLast ? 'font-roobert-medium' : 'font-roobert'}`}
              numberOfLines={1}
            >
              {segment.name}
            </Text>
          </Pressable>
        </React.Fragment>
      ))}
    </ScrollView>
  );
}

