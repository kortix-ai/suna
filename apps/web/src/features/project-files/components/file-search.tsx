'use client';

import { useTranslations } from 'next-intl';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { FileText, Folder, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFileSearch } from '../hooks';
import { useFilesStore } from '../store/files-store';

export function FileSearch() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      <div className="mx-auto mt-4 max-w-lg px-4" onClick={(e) => e.stopPropagation()}>
        <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-2xl">
          {/* Search input */}
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="text-muted-foreground h-4 w-4 shrink-0" />
            <Input
              type="text"
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileSearch.line109JsxAttrPlaceholderSearchFiles',
              )}
              className="h-10 border-0 px-0 shadow-none focus-visible:ring-0"
            />
            <button
              onClick={closeSearch}
              aria-label={tI18nHardcoded.raw(
                'autoFeaturesProjectFilesComponentsFileSearchJsxAttrAriaLabel732c1816',
              )}
              className="hover:bg-muted rounded p-1"
            >
              <X className="text-muted-foreground h-4 w-4" />
            </button>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[300px] overflow-y-auto">
            {debouncedQuery.length === 0 && (
              <div className="text-muted-foreground px-4 py-6 text-center text-sm">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileSearch.line124JsxTextTypeToSearchFiles',
                )}
              </div>
            )}

            {isLoading && debouncedQuery.length > 0 && (
              <div className="text-muted-foreground px-4 py-4 text-center text-sm">
                Searching...
              </div>
            )}

            {results && results.length === 0 && debouncedQuery.length > 0 && (
              <div className="text-muted-foreground px-4 py-6 text-center text-sm">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileSearch.line136JsxTextNoFilesFound',
                )}
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
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                      'transition-colors',
                      index === selectedIndex ? 'bg-muted' : 'hover:bg-muted',
                    )}
                  >
                    {isDir ? (
                      <Folder className="h-4 w-4 shrink-0 text-blue-400" />
                    ) : (
                      <FileText className="text-muted-foreground h-4 w-4 shrink-0" />
                    )}
                    <span className="flex-1 truncate font-medium">{name}</span>
                    <span className="text-muted-foreground max-w-[200px] truncate text-xs">
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
