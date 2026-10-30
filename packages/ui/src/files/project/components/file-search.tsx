'use client';

import { useTranslations } from '../../../i18n';

import { Input } from '../../../primitives/input';
import { Switch } from '../../../primitives/switch';
import { useFilesStore } from '../../../internal/stores/files-store';
import { cn } from '../../../lib/utils';
import {
  FileTextIcon as FileText,
  FolderIcon as Folder,
  MagnifyingGlassIcon as Search,
  XIcon as X,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileExplorerSource, type FileExplorerSource } from '../explorer-source';

const NAME_LIMIT = 30;
const CONTENT_LIMIT = 50;

/** A filename hit, or a content hit with the line it matched. */
interface SearchItem {
  key: string;
  path: string;
  line?: { number: number; text: string };
}

/** Stand-in for a source without content search: a hook that never fetches. */
const useNoContentSearch: NonNullable<FileExplorerSource['useFileContentSearch']> = () => ({
  data: undefined,
  isLoading: false,
  error: null,
});

export function FileSearch() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Search file contents (`git grep`) instead of names, where the source can.
  const [contentMode, setContentMode] = useState(false);
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

  const source = useFileExplorerSource();
  const canSearchContents = !!source.capabilities.contentSearch;
  const searchContents = canSearchContents && contentMode;
  const useFileContentSearch = source.useFileContentSearch ?? useNoContentSearch;
  const nameSearch = source.useFileSearch(debouncedQuery, {
    limit: NAME_LIMIT,
    enabled: debouncedQuery.length > 0 && !searchContents,
  });
  const contentSearch = useFileContentSearch(debouncedQuery, {
    limit: CONTENT_LIMIT,
    enabled: debouncedQuery.length > 0 && searchContents,
  });
  const { isLoading } = searchContents ? contentSearch : nameSearch;
  const limit = searchContents ? CONTENT_LIMIT : NAME_LIMIT;

  const results = useMemo<SearchItem[] | undefined>(() => {
    if (searchContents) {
      return contentSearch.data?.map((match) => ({
        key: `${match.path}:${match.lineNumber}`,
        path: match.path,
        line: { number: match.lineNumber, text: match.lineText },
      }));
    }
    return nameSearch.data?.map((path) => ({ key: path, path }));
  }, [searchContents, contentSearch.data, nameSearch.data]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const handleSelect = useCallback(
    (item: SearchItem) => {
      if (item.path.endsWith('/')) {
        navigateToPath(item.path.slice(0, -1));
      } else {
        openFile(item.path, item.line?.number);
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
        const next = selectedIndex < results.length - 1 ? selectedIndex + 1 : 0;
        setSelectedIndex(next);
        // Use requestAnimationFrame so the DOM has updated before scrolling
        requestAnimationFrame(() => scrollItemIntoView(next));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = selectedIndex > 0 ? selectedIndex - 1 : results.length - 1;
        setSelectedIndex(next);
        requestAnimationFrame(() => scrollItemIntoView(next));
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
    <div
      role="presentation"
      className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSearch();
        else e.stopPropagation();
      }}
    >
      <div className="mx-auto mt-4 max-w-lg px-4">
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
                searchContents
                  ? 'featuresProjectFilesComponentsFileSearch.searchContentsPlaceholder'
                  : 'featuresProjectFilesComponentsFileSearch.line109JsxAttrPlaceholderSearchFiles',
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

          {canSearchContents && (
            <div className="flex items-center border-b">
              <Switch
                label={tHardcodedUi.raw('featuresProjectFilesComponentsFileSearch.searchContents')}
                aria-label={tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileSearch.searchContents',
                )}
                checked={contentMode}
                onCheckedChange={(checked) => {
                  setContentMode(checked);
                  inputRef.current?.focus();
                }}
              />
            </div>
          )}

          {/* Results */}
          <div ref={listRef} className="max-h-[300px] overflow-y-auto">
            {debouncedQuery.length === 0 && (
              <div className="text-muted-foreground px-4 py-6 text-center text-sm">
                {tHardcodedUi.raw(
                  searchContents
                    ? 'featuresProjectFilesComponentsFileSearch.typeToSearchContents'
                    : 'featuresProjectFilesComponentsFileSearch.line124JsxTextTypeToSearchFiles',
                )}
              </div>
            )}

            {isLoading && debouncedQuery.length > 0 && (
              <div className="text-muted-foreground px-4 py-4 text-center text-sm">
                {tI18nHardcoded.raw('i18nComplete.text78c9d9f6ace0')}
              </div>
            )}

            {results && results.length === 0 && debouncedQuery.length > 0 && (
              <div className="text-muted-foreground px-4 py-6 text-center text-sm">
                {tHardcodedUi.raw(
                  searchContents
                    ? 'featuresProjectFilesComponentsFileSearch.noMatchingLines'
                    : 'featuresProjectFilesComponentsFileSearch.line136JsxTextNoFilesFound',
                )}
              </div>
            )}

            {results &&
              results.map((item, index) => {
                const filePath = item.path;
                const isDir = filePath.endsWith('/');
                const name = isDir
                  ? filePath.slice(0, -1).split('/').pop()
                  : filePath.split('/').pop();

                return (
                  <button
                    key={item.key}
                    data-search-item
                    onClick={() => handleSelect(item)}
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
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="flex-1 truncate font-medium">{name}</span>
                        <span className="text-muted-foreground max-w-[200px] truncate text-xs">
                          {filePath}
                        </span>
                      </span>
                      {item.line && (
                        <span className="text-muted-foreground flex min-w-0 gap-2 font-mono text-xs">
                          <span className="shrink-0 tabular-nums">{item.line.number}</span>
                          <span className="truncate">{item.line.text}</span>
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}

            {results && results.length >= limit && (
              <div className="text-muted-foreground px-3 py-2 text-xs">
                {tHardcodedUi('featuresProjectFilesComponentsFileSearch.firstMatches', {
                  value0: limit,
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
