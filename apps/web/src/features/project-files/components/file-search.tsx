'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, FileText, Folder, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useFileSearch } from '../hooks';
import { useFilesStore } from '../store/files-store';
import { cn } from '@/lib/utils';

export function FileSearch() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeSearch = useFilesStore((s) => s.closeSearch);
  const openFile = useFilesStore((s) => s.openFile);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);

  // Debounce the query
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { data: results, isLoading } = useFileSearch(debouncedQuery, {
    limit: 30,
    enabled: debouncedQuery.length > 0,
  });

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const handleSelect = useCallback(
    (path: string) => {
      if (path.endsWith('/')) {
        navigateToPath(path.slice(0, -1));
      } else {
        openFile(path);
      }
      closeSearch();
    },
    [openFile, navigateToPath, closeSearch],
  );

  // Scroll the item at the given index into view within the list container
  const scrollItemIntoView = useCallback((index: number) => {
    const container = listRef.current;
    if (!container) return;
    const items = container.querySelectorAll('[data-search-item]');
    items[index]?.scrollIntoView({ block: 'nearest' });
  }, []);

  // Handle keyboard navigation directly on the input
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
        return;
      }

      if (!results || results.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev < results.length - 1 ? prev + 1 : 0;
          // Use requestAnimationFrame so the DOM has updated before scrolling
          requestAnimationFrame(() => scrollItemIntoView(next));
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev > 0 ? prev - 1 : results.length - 1;
          requestAnimationFrame(() => scrollItemIntoView(next));
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex]);
        }
      }
    },
    [closeSearch, results, selectedIndex, handleSelect, scrollItemIntoView],
  );

  return (
    <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={closeSearch}>
      <div className="mx-auto max-w-lg mt-4 px-4" onClick={(e) => e.stopPropagation()}>
        <div className="rounded-lg border border-border bg-card shadow-2xl overflow-hidden">
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 border-b">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input type="text"
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Search files..."
              className="border-0 shadow-none focus-visible:ring-0 px-0 h-10"
            />
            <button
              onClick={closeSearch}
              className="p-1 rounded hover:bg-muted"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[300px] overflow-y-auto">
            {debouncedQuery.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                Type to search files...
              </div>
            )}

            {isLoading && debouncedQuery.length > 0 && (
              <div className="px-4 py-4 text-center text-sm text-muted-foreground">
                Searching...
              </div>
            )}

            {results && results.length === 0 && debouncedQuery.length > 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No files found
              </div>
            )}

            {results &&
              results.map((filePath, index) => {
                const isDir = filePath.endsWith('/');
                const name = isDir
                  ? filePath.slice(0, -1).split('/').pop()
                  : filePath.split('/').pop();

                return (
                  <button
                    key={filePath}
                    data-search-item
                    onClick={() => handleSelect(filePath)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-2 text-sm text-left',
                      'transition-colors',
                      index === selectedIndex
                        ? 'bg-muted'
                        : 'hover:bg-muted',
                    )}
                  >
                    {isDir ? (
                      <Folder className="h-4 w-4 text-blue-400 shrink-0" />
                    ) : (
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate flex-1 font-medium">{name}</span>
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {filePath}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
