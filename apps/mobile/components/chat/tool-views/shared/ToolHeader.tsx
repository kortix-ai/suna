import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { LucideIcon, Check, X, AlertCircle } from 'lucide-react-native';

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
  /** Error message to display (when isSuccess is false) */
  errorMessage?: string;
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
  errorMessage,
}: ToolHeaderProps) {
  const isError = !isSuccess && !isStreaming;
  
  return (
    <View className="flex-row items-center gap-3">
      <View className="relative">
        <View 
          className={`rounded-2xl items-center justify-center ${isError ? 'bg-rose-100 dark:bg-rose-900/30' : iconBgColor}`} 
          style={{ width: 48, height: 48 }}
        >
          <Icon 
            as={isError ? AlertCircle : IconComponent} 
            size={24} 
            className={isError ? 'text-rose-500 dark:text-rose-400' : iconColor} 
          />
        </View>
        {!isStreaming && showStatus && (
          <View
            className={`absolute -bottom-0.5 -right-0.5 rounded-full items-center justify-center ${isSuccess ? 'bg-emerald-500' : 'bg-rose-500'}`}
            style={{ width: 18, height: 18 }}
          >
            <Icon
              as={isSuccess ? Check : X}
              size={10}
              className="text-white"
            />
          </View>
        )}
      </View>
      <View className="flex-1 min-w-0">
        {subtitle && (
          <Text className={`text-xs font-roobert-medium uppercase tracking-wider mb-1 ${isError ? 'text-rose-500 dark:text-rose-400' : 'text-foreground/50'}`}>
            {subtitle || (isError ? 'Error' : '')}
          </Text>
        )}
        <Text 
          className={`font-roobert-semibold ${subtitle ? 'text-xl' : 'text-base'} ${isError ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`} 
          numberOfLines={1}
        >
          {title}
        </Text>
        {isError && errorMessage && (
          <Text className="text-xs text-rose-500 dark:text-rose-400 mt-0.5" numberOfLines={1}>
            {errorMessage.substring(0, 100)}{errorMessage.length > 100 ? '...' : ''}
          </Text>
        )}
      </View>
    </View>
  );
}

