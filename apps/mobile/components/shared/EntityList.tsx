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
import { KortixLoader } from '@/components/ui';
import { useColorScheme } from 'nativewind';

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
  const { colorScheme } = useColorScheme();
  
  const gapClass = `gap-${gap}`;
  
  // Loading State
  if (isLoading) {
    return (
      <View className="py-8 items-center">
        <KortixLoader size="small" />
        <Text 
          style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
          className="text-sm font-roobert mt-2"
        >
          {loadingMessage}
        </Text>
      </View>
    );
  }
  
  // Error State
  if (error) {
    return (
      <View className="py-8 items-center">
        <Text 
          style={{ color: colorScheme === 'dark' ? '#EF4444' : '#DC2626' }}
          className="text-sm font-roobert text-center mb-2"
        >
          {errorMessage}
        </Text>
        {onRetry && (
          <Text 
            onPress={onRetry}
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="text-sm font-roobert-medium underline"
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
        <Text 
          style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
          className="text-sm font-roobert text-center"
        >
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

