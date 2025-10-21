/**
 * Trigger List Component
 * 
 * Reusable list of triggers using the generic ItemList component
 */

import React from 'react';
import { type ViewProps } from 'react-native';
import { ItemList } from '@/components/shared/ItemList';
import { TriggerListItem } from './TriggerListItem';
import type { TriggerWithAgent } from '@/api/types';
import { Zap } from 'lucide-react-native';

interface TriggerListProps extends ViewProps {
  triggers: TriggerWithAgent[];
  onTriggerPress?: (trigger: TriggerWithAgent) => void;
  isLoading?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  emptyStateAction?: {
    label: string;
    onPress: () => void;
  };
  showSearch?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  onSearchClear?: () => void;
  disableVirtualization?: boolean;
}

export function TriggerList({
  triggers,
  onTriggerPress,
  isLoading = false,
  isRefreshing = false,
  onRefresh,
  emptyStateTitle,
  emptyStateDescription,
  emptyStateAction,
  showSearch = false,
  searchQuery = '',
  onSearchChange,
  onSearchClear,
  disableVirtualization = false,
  style,
  ...props
}: TriggerListProps) {
  return (
    <ItemList
      items={triggers}
      keyExtractor={(trigger) => trigger.trigger_id}
      renderItem={(trigger) => (
        <TriggerListItem
          trigger={trigger}
          onPress={onTriggerPress}
        />
      )}
      showSearch={showSearch}
      searchQuery={searchQuery}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search triggers..."
      onSearchClear={onSearchClear}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      onRefresh={onRefresh}
      disableVirtualization={disableVirtualization}
      emptyState={{
        icon: Zap,
        title: emptyStateTitle || "No triggers found",
        description: emptyStateDescription || "Create your first trigger to get started",
        action: emptyStateAction,
      }}
      style={style}
      {...props}
    />
  );
}
