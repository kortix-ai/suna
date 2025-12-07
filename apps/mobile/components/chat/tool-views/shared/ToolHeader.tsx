import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { LucideIcon, Check, X } from 'lucide-react-native';

export interface ToolHeaderProps {
  /** Icon component to display */
  icon: LucideIcon;
  /** Icon color class (e.g., 'text-primary') */
  iconColor: string;
  /** Background color class for icon container (e.g., 'bg-primary/10') */
  iconBgColor: string;
  /** Tool category or type label */
  subtitle: string;
  /** Main title/heading */
  title: string;
  /** Whether the tool execution was successful */
  isSuccess?: boolean;
  /** Whether to show the status icon */
  showStatus?: boolean;
  /** Whether the tool is currently streaming/executing */
  isStreaming?: boolean;
}

/**
 * ToolHeader Component
 * 
 * A clean, reusable header component for tool views that displays:
 * - Tool icon with colored background
 * - Subtitle (tool category/type)
 * - Title (tool name)
 * - Status indicator (success/error badge when not streaming)
 * 
 * Used internally by ToolViewCard but can also be used standalone.
 */
export function ToolHeader({
  icon: IconComponent,
  iconColor,
  iconBgColor,
  subtitle,
  title,
  isSuccess = true,
  showStatus = true,
  isStreaming = false,
}: ToolHeaderProps) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="relative">
        <View className={`${iconBgColor} rounded-2xl items-center justify-center`} style={{ width: 48, height: 48 }}>
          <Icon as={IconComponent} size={24} className={iconColor} />
        </View>
        {!isStreaming && showStatus && (
          <View
            className={`absolute -bottom-0.5 -right-0.5 rounded-full items-center justify-center ${isSuccess ? 'bg-primary' : 'bg-destructive'}`}
            style={{ width: 18, height: 18 }}
          >
            <Icon
              as={isSuccess ? Check : X}
              size={10}
              className="text-primary-foreground"
            />
          </View>
        )}
      </View>
      <View className="flex-1 min-w-0">
        {subtitle && (
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
            {subtitle}
          </Text>
        )}
        <Text className={`font-roobert-semibold text-foreground ${subtitle ? 'text-xl' : 'text-base'}`} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </View>
  );
}

