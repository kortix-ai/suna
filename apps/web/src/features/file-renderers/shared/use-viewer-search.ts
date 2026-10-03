'use client';

import * as React from 'react';

export function useViewerSearch<Result>(
  findResults: (query: string) => Promise<Result[]>,
  identity: string,
  onClear?: () => void,
  onIdentityClear?: () => void,
) {
  const [searchDraft, setSearchDraft] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<Result[]>([]);
  const [activeResultIndex, setActiveResultIndex] = React.useState(0);
  const [isSearching, setIsSearching] = React.useState(false);
  const searchRequestIdRef = React.useRef(0);
  const appliedResultKeyRef = React.useRef('');
  const runSearch = React.useCallback(
    (rawQuery: string) => {
      const nextQuery = rawQuery.trim();
      const requestId = searchRequestIdRef.current + 1;
      searchRequestIdRef.current = requestId;
      appliedResultKeyRef.current = '';
      setSearchQuery(nextQuery);
      setActiveResultIndex(0);

      if (!nextQuery) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      setIsSearching(true);
      void findResults(nextQuery)
        .then((nextResults) => {
          if (searchRequestIdRef.current !== requestId) return;
          setSearchResults(nextResults);
        })
        .catch(() => {
          if (searchRequestIdRef.current !== requestId) return;
          setSearchResults([]);
        })
        .finally(() => {
          if (searchRequestIdRef.current !== requestId) return;
          setIsSearching(false);
        });
    },
    [findResults],
  );

  React.useEffect(() => {
    if (!searchDraft.trim()) {
      runSearch('');
      return;
    }

    setIsSearching(true);
    const timeoutId = window.setTimeout(() => {
      runSearch(searchDraft);
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [runSearch, searchDraft]);

  const resetSearch = React.useCallback(() => {
    searchRequestIdRef.current += 1;
    setSearchDraft('');
    setSearchQuery('');
    setSearchResults([]);
    setActiveResultIndex(0);
    setIsSearching(false);
    appliedResultKeyRef.current = '';
  }, []);

  const clearSearch = React.useCallback(() => {
    resetSearch();
    onClear?.();
  }, [onClear, resetSearch]);

  const goToRelativeResult = React.useCallback(
    (direction: 1 | -1) => {
      if (!searchResults.length) return;

      setActiveResultIndex(
        (currentIndex) => (currentIndex + direction + searchResults.length) % searchResults.length,
      );
    },
    [searchResults.length],
  );

  React.useEffect(() => {
    resetSearch();
    onIdentityClear?.();
  }, [identity, onIdentityClear, resetSearch]);

  return {
    searchDraft,
    setSearchDraft,
    searchQuery,
    searchResults,
    activeResultIndex,
    isSearching,
    appliedResultKeyRef,
    runSearch,
    clearSearch,
    goToRelativeResult,
  };
}
