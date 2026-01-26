import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useMemo } from 'react';
import { searchThreads, ThreadSearchResponse } from '@/lib/api/threads';
import { threadKeys } from './keys';

const DEBOUNCE_DELAY = 400; // ms
const MIN_QUERY_LENGTH = 2;

/**
 * Hook for semantic thread search with debouncing.
 *
 * @param query - The search query text
 * @param limit - Maximum number of results (default: 10)
 * @returns Object containing search data, loading states, and configuration status
 */
export const useThreadSearch = (query: string, limit: number = 10) => {
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce the query
  useEffect(() => {
    // Don't debounce if query is too short - immediately clear
    if (query.length < MIN_QUERY_LENGTH) {
      setDebouncedQuery('');
      return;
    }

    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, DEBOUNCE_DELAY);

    return () => clearTimeout(timer);
  }, [query]);

  // Only run the query when we have a debounced query
  const shouldSearch = debouncedQuery.length >= MIN_QUERY_LENGTH;

  const {
    data,
    isLoading: isQueryLoading,
    isFetching,
    error,
  } = useQuery<ThreadSearchResponse>({
    queryKey: [...threadKeys.lists(), 'search', debouncedQuery, limit],
    queryFn: () => searchThreads(debouncedQuery, limit),
    enabled: shouldSearch,
    staleTime: 30 * 1000, // 30 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });

  // Compute loading state:
  // - isSearching: true when we're actively searching (debounce wait or fetching)
  // - isLoading: true when waiting for initial data
  const isDebouncing = query.length >= MIN_QUERY_LENGTH && query !== debouncedQuery;
  const isSearching = isDebouncing || isFetching;
  const isLoading = shouldSearch && isQueryLoading;

  // Return results
  const results = useMemo(() => {
    if (!shouldSearch || !data) {
      return [];
    }
    return data.results || [];
  }, [shouldSearch, data]);

  return {
    results,
    total: data?.total || 0,
    isLoading,
    isSearching,
    isConfigured: data?.configured ?? true, // Assume configured if no data yet
    error,
    query: debouncedQuery,
    shouldSearch,
  };
};
