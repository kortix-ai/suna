import React, { Fragment } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronRight } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import type { LucideIcon } from 'lucide-react-native';

export interface BreadcrumbSegment {
  name: string;
  path: string;
  isLast: boolean;
}

interface KortixComputerHeaderProps {
  /** Icon to display in the header */
  icon: LucideIcon;
  /** Click handler for the icon button */
  onIconClick?: () => void;
  /** Tooltip/title for the icon button (not shown on mobile, used for accessibility) */
  iconTitle?: string;
  
  /** Simple title to display (mutually exclusive with breadcrumbs and fileName) */
  title?: string;
  
  /** File name to display with chevron separator (for file viewer) */
  fileName?: string;
  
  /** Breadcrumb segments to display (mutually exclusive with title and fileName) */
  breadcrumbs?: BreadcrumbSegment[];
  /** Click handler for breadcrumb navigation */
  onBreadcrumbClick?: (path: string) => void;
  
  /** Actions to display on the right side */
  actions?: React.ReactNode;
}

/**
 * Shared header component for all Kortix Computer views (Files, File Viewer, Browser).
 * Ensures consistent styling and prevents layout jumps when switching tabs.
 * 
 * ALL styling is controlled here - consumers only pass data props.
 */
export function KortixComputerHeader({
  icon: IconComponent,
  onIconClick,
  iconTitle,
  title,
  fileName,
  breadcrumbs,
  onBreadcrumbClick,
  actions,
}: KortixComputerHeaderProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const handleIconPress = () => {
    if (onIconClick) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onIconClick();
    }
  };

  const handleBreadcrumbPress = (path: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onBreadcrumbClick?.(path);
  };

  return (
    <View
      className="px-4 py-2 flex-row items-center justify-between"
      style={{
        height: 56,
        backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
        borderBottomWidth: 1,
        borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
      }}
    >
      {/* Left section: Icon + Title/Breadcrumbs/FileName */}
      <View className="flex-row items-center flex-1 min-w-0">
        {/* Icon Button */}
        <Pressable
          onPress={handleIconPress}
          disabled={!onIconClick}
          className="p-2 rounded-lg border flex-shrink-0"
          style={{
            backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
            borderColor: isDark ? 'rgba(248, 248, 248, 0.15)' : 'rgba(18, 18, 21, 0.15)',
            marginRight: 12,
          }}
          accessibilityLabel={iconTitle}
        >
          <Icon
            as={IconComponent}
            size={20}
            color={isDark ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)'}
            strokeWidth={2}
          />
        </Pressable>

        {/* Simple Title */}
        {title && (
          <Text className="text-base font-roobert-medium text-foreground">
            {title}
          </Text>
        )}

        {/* File Name with Chevron (for file viewer) */}
        {fileName && (
          <View className="flex-row items-center flex-1 min-w-0">
            <Icon
              as={ChevronRight}
              size={12}
              color={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)'}
              strokeWidth={2}
              style={{ marginRight: 4 }}
            />
            <Text 
              className="text-base font-roobert-medium text-foreground flex-1 min-w-0"
              numberOfLines={1}
            >
              {fileName}
            </Text>
          </View>
        )}

        {/* Breadcrumbs */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ alignItems: 'center' }}
            className="flex-1"
          >
            <View className="flex-row items-center gap-1.5">
              {breadcrumbs.map((segment, index) => (
                <Fragment key={segment.path}>
                  {index > 0 && (
                    <Text 
                      style={{ 
                        color: isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)',
                        fontSize: 14,
                      }}
                    >
                      /
                    </Text>
                  )}
                  <Pressable
                    onPress={() => handleBreadcrumbPress(segment.path)}
                    className="active:opacity-70"
                  >
                    <Text
                      className={`text-base ${
                        segment.isLast 
                          ? 'font-roobert-medium text-foreground' 
                          : 'text-muted-foreground'
                      }`}
                      numberOfLines={1}
                      style={{ maxWidth: 150 }}
                    >
                      {segment.name}
                    </Text>
                  </Pressable>
                </Fragment>
              ))}
            </View>
          </ScrollView>
        )}
      </View>

      {/* Right section: Actions */}
      {actions && (
        <View className="flex-row items-center gap-1.5 flex-shrink-0 ml-2">
          {actions}
        </View>
      )}
    </View>
  );
}




