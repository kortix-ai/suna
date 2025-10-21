/**
 * Trigger List Component
 * 
 * Reusable list of triggers with search, empty state, and loading skeleton
 * Used in MenuPage triggers tab and other trigger list views
 */

import React, { useMemo } from 'react';
import { View, ScrollView, RefreshControl, type ViewProps } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { TriggerListItem } from './TriggerListItem';
import { useSearch } from '@/lib/search';
import { getTriggerCategory } from '@/lib/trigger-utils';
import type { TriggerWithAgent } from '@/api/types';
import { Zap, Search } from 'lucide-react-native';

interface TriggerListProps extends ViewProps {
  triggers: TriggerWithAgent[];
  onTriggerPress?: (trigger: TriggerWithAgent) => void;
  isLoading?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  showAgent?: boolean;
  compact?: boolean;
  groupByCategory?: boolean;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  emptyStateAction?: {
    label: string;
    onPress: () => void;
  };
}

const LoadingSkeleton = ({ compact = false }: { compact?: boolean }) => (
  <View className="p-4 bg-background border-b border-border/30">
    <View className="flex-row items-start">
      <View className="w-10 h-10 bg-muted rounded-full mr-3 animate-pulse" />
      <View className="flex-1">
        <View className="h-4 bg-muted rounded w-3/4 mb-2 animate-pulse" />
        <View className="h-3 bg-muted rounded w-1/2 mb-2 animate-pulse" />
        {!compact && (
          <>
            <View className="h-3 bg-muted rounded w-1/3 mb-2 animate-pulse" />
            <View className="flex-row items-center justify-between mt-2">
              <View className="h-6 bg-muted rounded w-16 animate-pulse" />
              <View className="h-3 bg-muted rounded w-12 animate-pulse" />
            </View>
          </>
        )}
      </View>
    </View>
  </View>
);

const EmptyState = ({
  title = "No triggers found",
  description = "Create your first trigger to get started",
  action,
}: {
  title?: string;
  description?: string;
  action?: { label: string; onPress: () => void };
}) => (
  <View className="flex-1 items-center justify-center p-8">
    <View className="w-16 h-16 bg-muted rounded-full items-center justify-center mb-4">
      <Icon as={Zap} size={24} color="text-muted-foreground" />
    </View>
    <Text className="text-foreground text-lg font-roobert-medium mb-2 text-center">
      {title}
    </Text>
    <Text className="text-muted-foreground text-sm font-roobert text-center mb-6 max-w-sm">
      {description}
    </Text>
    {action && (
      <View className="px-4 py-2 bg-primary rounded-lg">
        <Text className="text-primary-foreground text-sm font-roobert-medium">
          {action.label}
        </Text>
      </View>
    )}
  </View>
);

const SearchHeader = ({
  query,
  onSearchChange,
  placeholder = "Search triggers...",
}: {
  query: string;
  onSearchChange: (query: string) => void;
  placeholder?: string;
}) => (
  <View className="px-4 py-3 bg-background border-b border-border/30">
    <View className="flex-row items-center bg-muted rounded-lg px-3 py-2">
      <Icon as={Search} size={16} color="text-muted-foreground" />
      <Text className="text-muted-foreground text-sm font-roobert ml-2 flex-1">
        {query || placeholder}
      </Text>
    </View>
  </View>
);

const CategoryHeader = ({ category }: { category: string }) => (
  <View className="px-4 py-2 bg-muted/30 border-b border-border/20">
    <Text className="text-muted-foreground text-xs font-roobert-medium uppercase tracking-wide">
      {category === 'scheduled' ? 'Scheduled Triggers' : 'App Triggers'}
    </Text>
  </View>
);

export function TriggerList({
  triggers,
  onTriggerPress,
  isLoading = false,
  isRefreshing = false,
  onRefresh,
  searchQuery = '',
  onSearchChange,
  showAgent = true,
  compact = false,
  groupByCategory = false,
  emptyStateTitle,
  emptyStateDescription,
  emptyStateAction,
  style,
  ...props
}: TriggerListProps) {
  // Search functionality
  const searchableTriggers = useMemo(() =>
    triggers.map(trigger => ({ ...trigger, id: trigger.trigger_id })),
    [triggers]
  );

  const { query, results, clearSearch, updateQuery } = useSearch(searchableTriggers, [
    'name',
    'description',
    'agent_name',
    'trigger_type',
  ]);

  const filteredTriggers = useMemo(() => {
    const searchResults = results.map(result => ({ ...result, trigger_id: result.id }));
    return searchQuery ? searchResults : triggers;
  }, [results, triggers, searchQuery]);

  // Group by category if requested
  const groupedTriggers = useMemo(() => {
    if (!groupByCategory) return { all: filteredTriggers };

    const scheduled = filteredTriggers.filter(t => getTriggerCategory(t.trigger_type) === 'scheduled');
    const app = filteredTriggers.filter(t => getTriggerCategory(t.trigger_type) === 'app');

    return { scheduled, app };
  }, [filteredTriggers, groupByCategory]);

  const renderTrigger = ({ item }: { item: TriggerWithAgent }) => (
    <TriggerListItem
      trigger={item}
      onPress={onTriggerPress}
      showAgent={showAgent}
      compact={compact}
    />
  );

  const renderSectionHeader = ({ section }: { section: { title: string } }) => (
    <CategoryHeader category={section.title} />
  );

  const renderItem = ({ item }: { item: TriggerWithAgent }) => renderTrigger({ item });

  if (isLoading) {
    return (
      <View className="flex-1 bg-background" style={style} {...props}>
        {Array.from({ length: 5 }).map((_, index) => (
          <LoadingSkeleton key={index} compact={compact} />
        ))}
      </View>
    );
  }

  if (filteredTriggers.length === 0) {
    return (
      <View className="flex-1 bg-background" style={style} {...props}>
        <EmptyState
          title={emptyStateTitle}
          description={emptyStateDescription}
          action={emptyStateAction}
        />
      </View>
    );
  }

  if (groupByCategory) {
    const sections = Object.entries(groupedTriggers)
      .filter(([_, items]) => items.length > 0)
      .map(([category, items]) => ({
        title: category,
        data: items,
      }));

    return (
      <View className="flex-1 bg-background" style={style} {...props}>
        {onSearchChange && (
          <SearchHeader
            query={searchQuery}
            onSearchChange={onSearchChange}
          />
        )}
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={onRefresh}
                tintColor="#666"
              />
            ) : undefined
          }
        >
          {sections.map((section) => (
            <View key={section.title}>
              <CategoryHeader category={section.title} />
              {section.data.map((trigger: TriggerWithAgent) => (
                <TriggerListItem
                  key={trigger.trigger_id}
                  trigger={trigger}
                  onPress={onTriggerPress}
                  showAgent={showAgent}
                  compact={compact}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background" style={style} {...props}>
      {onSearchChange && (
        <SearchHeader
          query={searchQuery}
          onSearchChange={onSearchChange}
        />
      )}
      <FlatList
        data={filteredTriggers}
        keyExtractor={(item) => item.trigger_id}
        renderItem={renderItem}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              tintColor="#666"
            />
          ) : undefined
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
