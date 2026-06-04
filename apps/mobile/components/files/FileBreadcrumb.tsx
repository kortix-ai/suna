/**
 * File Breadcrumb Navigation Component
 * Clean, lean, elegant breadcrumb trail for navigating file paths
 */

import React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronRight, Folder } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';

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
      >
        <Icon
          as={Folder}
          size={14}
          color={segments.length === 0
            ? (isDark ? '#f8f8f8' : '#121215')
            : (isDark ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)')
          }
          strokeWidth={2}
        />
      </Pressable>

      {/* Path segments */}
      {segments.map((segment, index) => (
        <React.Fragment key={segment.path}>
          <Icon
            as={ChevronRight}
            size={12}
            color={isDark ? 'rgba(248, 248, 248, 0.25)' : 'rgba(18, 18, 21, 0.25)'}
            strokeWidth={2}
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
                  ? (isDark ? '#f8f8f8' : '#121215')
                  : (isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'),
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

