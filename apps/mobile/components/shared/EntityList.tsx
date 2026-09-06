/**
 * EntityList Component - Unified list container for all entity types
 * 
 * A reusable list container that handles:
 * - Loading states
 * - Empty states  
 * - Error states
 * - Consistent spacing
 * - Search results
 * 
 * Works with any entity type (Agents, Models, Threads, Triggers)
 */

import React, { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';

export interface EntityListProps<T> {
  /** Array of entities to display */
  entities: T[];
  
  /** Whether data is loading */
  isLoading?: boolean;
  
  /** Error state */
  error?: Error | null;
  
  /** Search query (if any) */
  searchQuery?: string;
  
  /** Render function for each item */
  renderItem: (item: T, index: number) => ReactNode;
  
  /** Gap between items (in Tailwind units, default: 4 = 16px) */
  gap?: number;
  
  /** Empty state message */
  emptyMessage?: string;
  
  /** No results message (when searching) */
  noResultsMessage?: string;
  
  /** Loading message */
  loadingMessage?: string;
  
  /** Error message */
  errorMessage?: string;
  
  /** Show retry button on error */
  onRetry?: () => void;
}

export function EntityList<T>({
  entities,
  isLoading = false,
  error = null,
  searchQuery = '',
  renderItem,
  gap = 4,
  emptyMessage = 'No items',
  noResultsMessage = 'No results found',
  loadingMessage = 'Loading...',
  errorMessage = 'Failed to load items',
  onRetry,
}: EntityListProps<T>) {
  const gapClass = `gap-${gap}`;
  
  // Loading State
  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center" style={{ minHeight: 200 }}>
        <KortixLoader size="small" />
        <Text className="text-sm font-roobert mt-2 text-muted-foreground">
          {loadingMessage}
        </Text>
      </View>
    );
  }
  
  // Error State
  if (error) {
    return (
      <View className="py-8 items-center">
        <Text className="text-sm font-roobert text-center mb-2 text-destructive">
          {errorMessage}
        </Text>
        {onRetry && (
          <Text
            onPress={onRetry}
            className="text-sm font-roobert-medium underline text-foreground"
          >
            Retry
          </Text>
        )}
      </View>
    );
  }
  
  // Empty State
  if (entities.length === 0) {
    return (
      <View className="py-8 items-center">
        <Text className="text-sm font-roobert text-center text-muted-foreground">
          {searchQuery ? noResultsMessage : emptyMessage}
        </Text>
      </View>
    );
  }
  
  // Render List
  return (
    <View className={gapClass}>
      {entities.map((entity, index) => renderItem(entity, index))}
    </View>
  );
}

