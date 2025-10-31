/**
 * Search Utilities using Fuse.js
 * 
 * Provides fuzzy search functionality across different data types:
 * - Conversations/Threads
 * - Agents/Workers  
 * - Triggers
 * - Any object with searchable text fields
 */

import * as React from 'react';
import Fuse, { FuseResultMatch } from 'fuse.js';

export interface SearchableItem {
  id: string;
  [key: string]: any; // Allow any additional properties
}

export interface SearchResult<T extends SearchableItem> {
  item: T;
  score?: number;
  matches?: readonly FuseResultMatch[];
}

/**
 * Create a Fuse instance for searching
 */
function createFuseInstance<T extends SearchableItem>(
  items: T[],
  searchFields: string[]
): Fuse<T> {
  return new Fuse(items, {
    keys: searchFields,
    threshold: 0.4, // 0.0 = perfect match, 1.0 = match anything
    includeScore: true,
    includeMatches: true,
    minMatchCharLength: 1,
    shouldSort: true,
  });
}

/**
 * Search through a list of items using Fuse.js
 * 
 * @param items - Array of items to search through
 * @param query - Search query string
 * @param searchFields - Fields to search in
 * @returns Array of search results sorted by relevance
 */
export function searchItems<T extends SearchableItem>(
  items: T[],
  query: string,
  searchFields: string[] = ['name', 'description', 'title']
): SearchResult<T>[] {
  if (!query.trim()) {
    return items.map(item => ({
      item,
      score: 1,
    }));
  }

  const fuse = createFuseInstance(items, searchFields);
  const results = fuse.search(query);
  
  return results.map(result => ({
    item: result.item,
    score: result.score,
    matches: result.matches,
  }));
}

/**
 * Search hook for managing search state and results
 */
export function useSearch<T extends SearchableItem>(
  items: T[],
  searchFields: string[] = ['name', 'description', 'title']
) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResult<T>[]>([]);
  
  // Memoize items to prevent infinite loops when items array is recreated
  const memoizedItems = React.useMemo(() => items, [items.length, JSON.stringify(items.map(item => item.id))]);
  
  // Memoize searchFields to prevent infinite loops
  const memoizedSearchFields = React.useMemo(() => searchFields, [searchFields.join(',')]);
  
  React.useEffect(() => {
    const searchResults = searchItems(memoizedItems, query, memoizedSearchFields);
    setResults(searchResults);
  }, [memoizedItems, query, memoizedSearchFields]);
  
  const clearSearch = React.useCallback(() => {
    setQuery('');
  }, []);
  
  const updateQuery = React.useCallback((newQuery: string) => {
    console.log('🔍 Search query updated:', newQuery);
    setQuery(newQuery);
  }, []);
  
  return {
    query,
    results: results.map(r => r.item), // Return just the items for convenience
    searchResults: results, // Return full results with scores
    clearSearch,
    updateQuery,
    isSearching: query.length > 0
  };
}
