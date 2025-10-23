/**
 * Generic ItemList Component
 * 
 * Reusable scrollable list with search, categories, loading states, and empty states.
 * Works with any data type through generic typing.
 */

import React, { ReactNode } from 'react';
import { View, RefreshControl, FlatList, ActivityIndicator, type ViewProps } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { SearchBar } from '@/components/ui/SearchBar';
import type { LucideIcon } from 'lucide-react-native';
import { Inbox } from 'lucide-react-native';

export interface ItemListSection<T> {
  id: string;
  title: string;
  data: T[];
}

export interface ItemListProps<T> extends ViewProps {
  /** Array of items to display */
  items: T[];
  /** Render function for each item */
  renderItem: (item: T) => ReactNode;
  /** Extract unique key from item */
  keyExtractor: (item: T) => string;
  /** Whether to show search bar */
  showSearch?: boolean;
  /** Search query value */
  searchQuery?: string;
  /** Search query change handler */
  onSearchChange?: (query: string) => void;
  /** Search placeholder text */
  searchPlaceholder?: string;
  /** Clear search handler */
  onSearchClear?: () => void;
  /** Whether data is loading */
  isLoading?: boolean;
  /** Whether pull-to-refresh is active */
  isRefreshing?: boolean;
  /** Pull-to-refresh handler */
  onRefresh?: () => void;
  /** Group items by category */
  groupByCategory?: boolean;
  /** Category extractor function */
  getCategoryId?: (item: T) => string;
  /** Category title formatter */
  formatCategoryTitle?: (categoryId: string) => string;
  /** Category icon getter */
  getCategoryIcon?: (categoryId: string) => string;
  /** Empty state configuration */
  emptyState?: {
    icon?: LucideIcon;
    title?: string;
    description?: string;
    action?: {
      label: string;
      onPress: () => void;
    };
  };
  /** Loading skeleton count */
  skeletonCount?: number;
  /** Disable FlatList and render items directly (for use inside ScrollView) */
  disableVirtualization?: boolean;
}

const LoadingSkeleton = () => {
  const { colorScheme } = useColorScheme();
  const bgColor = colorScheme === 'dark' ? '#161618' : '#F5F5F5';
  
  return (
    <View className="flex-row items-center gap-2.5 mb-3">
      <View 
        style={{ 
          width: 48, 
          height: 48, 
          backgroundColor: bgColor, 
          borderRadius: 16 
        }} 
      />
      <View className="flex-1 gap-2">
        <View 
          style={{ 
            height: 16, 
            backgroundColor: bgColor, 
            borderRadius: 8, 
            width: '75%' 
          }} 
        />
        <View 
          style={{ 
            height: 14, 
            backgroundColor: bgColor, 
            borderRadius: 7, 
            width: '50%' 
          }} 
        />
      </View>
    </View>
  );
};

const EmptyState = ({
  icon: IconComponent = Inbox,
  title = "No items found",
  description = "There are no items to display",
  action,
}: {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  action?: { label: string; onPress: () => void };
}) => {
  const { colorScheme } = useColorScheme();
  
  return (
    <View className="flex-1 items-center justify-center p-8 py-16">
      <View 
        className="w-16 h-16 rounded-2xl items-center justify-center mb-4"
        style={{
          backgroundColor: colorScheme === 'dark' ? '#161618' : '#F5F5F5',
        }}
      >
        <Icon 
          as={IconComponent} 
          size={24} 
          color={colorScheme === 'dark' ? '#666' : '#999'} 
        />
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
};

const CategoryHeader = ({ 
  title, 
  icon 
}: { 
  title: string; 
  icon?: string; 
}) => {
  const { colorScheme } = useColorScheme();
  
  return (
    <View 
      className="px-4 py-3 mb-3 mt-2"
      style={{
        backgroundColor: colorScheme === 'dark' ? '#161618' : '#F5F5F5',
        borderRadius: 12,
      }}
    >
      <Text 
        className="text-xs font-roobert-semibold uppercase tracking-wider"
        style={{ 
          color: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
          opacity: 0.6
        }}
      >
        {icon && `${icon} `}{title}
      </Text>
    </View>
  );
};

export function ItemList<T>({
  items,
  renderItem,
  keyExtractor,
  showSearch = false,
  searchQuery = '',
  onSearchChange,
  searchPlaceholder = 'Search...',
  onSearchClear,
  isLoading = false,
  isRefreshing = false,
  onRefresh,
  groupByCategory = false,
  getCategoryId,
  formatCategoryTitle,
  getCategoryIcon,
  emptyState,
  skeletonCount = 5,
  disableVirtualization = false,
  style,
  ...props
}: ItemListProps<T>) {
  const { colorScheme } = useColorScheme();

  // Group items by category if requested
  const sections = React.useMemo(() => {
    if (!groupByCategory || !getCategoryId) {
      return [{ id: 'all', title: '', data: items }];
    }

    const grouped = items.reduce((acc, item) => {
      const categoryId = getCategoryId(item);
      if (!acc[categoryId]) {
        acc[categoryId] = [];
      }
      acc[categoryId].push(item);
      return acc;
    }, {} as Record<string, T[]>);

    return Object.entries(grouped).map(([categoryId, data]) => ({
      id: categoryId,
      title: formatCategoryTitle ? formatCategoryTitle(categoryId) : categoryId,
      data,
    }));
  }, [items, groupByCategory, getCategoryId, formatCategoryTitle]);

  // Loading state
  if (isLoading) {
    return (
      <View className="flex-1" style={style} {...props}>
        {showSearch && (
          <View className="mb-4">
            <SearchBar
              value=""
              onChangeText={() => {}}
              placeholder={searchPlaceholder}
            />
          </View>
        )}
        {Array.from({ length: skeletonCount }).map((_, index) => (
          <LoadingSkeleton key={index} />
        ))}
      </View>
    );
  }

  // Empty state
  if (items.length === 0) {
    return (
      <View className="flex-1" style={style} {...props}>
        {showSearch && (
          <View className="mb-4">
            <SearchBar
              value={searchQuery}
              onChangeText={onSearchChange || (() => {})}
              placeholder={searchPlaceholder}
              onClear={onSearchClear}
            />
          </View>
        )}
        <EmptyState {...emptyState} />
      </View>
    );
  }

  // Render with categories
  if (groupByCategory && sections.length > 1) {
    return (
      <View className="flex-1" style={style} {...props}>
        {showSearch && (
          <View className="mb-4">
            <SearchBar
              value={searchQuery}
              onChangeText={onSearchChange || (() => {})}
              placeholder={searchPlaceholder}
              onClear={onSearchClear}
            />
          </View>
        )}
        <FlatList
          data={sections}
          keyExtractor={(section) => section.id}
          renderItem={({ item: section }) => (
            <View>
              {section.title && (
                <CategoryHeader 
                  title={section.title} 
                  icon={getCategoryIcon ? getCategoryIcon(section.id) : undefined}
                />
              )}
              {section.data.map((item) => (
                <View key={keyExtractor(item)}>
                  {renderItem(item)}
                </View>
              ))}
            </View>
          )}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={onRefresh}
                tintColor={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
              />
            ) : undefined
          }
          showsVerticalScrollIndicator={false}
        />
      </View>
    );
  }

  // Render flat list
  return (
    <View className="flex-1" style={style} {...props}>
      {showSearch && (
        <View className="mb-4">
          <SearchBar
            value={searchQuery}
            onChangeText={onSearchChange || (() => {})}
            placeholder={searchPlaceholder}
            onClear={onSearchClear}
          />
        </View>
      )}
      {disableVirtualization ? (
        // Render items directly (for use inside ScrollView)
        <>
          {items.map((item) => (
            <View key={keyExtractor(item)}>
              {renderItem(item)}
            </View>
          ))}
        </>
      ) : (
        // Use FlatList for virtualization
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={({ item }) => <>{renderItem(item)}</>}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={onRefresh}
                tintColor={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
              />
            ) : undefined
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

