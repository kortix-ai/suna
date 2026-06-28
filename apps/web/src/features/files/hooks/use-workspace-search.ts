'use client';

/**
 * useWorkspaceSearch — Standalone file/folder/content search hook.
 *
 * Reusable across CMD+K palette, @-mention input, file browser, etc.
 * Uses the OpenCode find.files + find.text APIs.
 *
 * Features:
 *   - Debounced async search (configurable delay)
 *   - Parallel file + directory search for maximum coverage
 *   - Smart ranking: exact basename > startsWith > includes > path > fuzzy
 *   - Depth penalty (shallower results rank higher)
 *   - Content search via prefix (e.g. ">" prefix for ripgrep)
 *   - Returns structured results with name, path, isDir
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useServerStore } from '@/stores/server-store';
import { findText } from '../api/opencode-files';
import type { FindMatch } from '../types';
import {
  type WorkspaceSearchEntry,
  parseWorkspacePaths,
  rankWorkspaceSearchEntry,
} from '../search/workspace-search-core';
import {
  searchWorkspaceFileEntries,
  searchWorkspaceFilePaths,
} from '../search/workspace-search-service';

// ── Types ────────────────────────────────────────────────────────────────

export type FileSearchResult = WorkspaceSearchEntry;

export interface WorkspaceSearchState {
  /** File/directory results (for name search) */
  results: FileSearchResult[];
  /** Content match results (for text/ripgrep search) */
  textResults: FindMatch[];
  /** Whether a search is in progress */
  isLoading: boolean;
  /** The query that produced the current results */
  searchedQuery: string;
  /** Whether the current query is a content search */
  isContentSearch: boolean;
  /** Effective query (without content search prefix) */
  effectiveQuery: string;
  /** Convenience: true if there are any results */
  hasResults: boolean;
}

export interface UseWorkspaceSearchOptions {
  /** Debounce delay in ms (default: 150) */
  debounceMs?: number;
  /** Max file results to return (default: 50) */
  maxResults?: number;
  /** Max content results to return (default: 50) */
  maxTextResults?: number;
  /** Prefix that triggers content search (default: ">") */
  contentSearchPrefix?: string;
  /** Per-API call limit (default: 100) */
  apiLimit?: number;
  /** Minimum query length to trigger search (default: 1) */
  minQueryLength?: number;
}

// ── Ranking ──────────────────────────────────────────────────────────────

/**
 * Smart ranking for file search results.
 * Lower score = better match.
 *
 * Priority tiers:
 *   0xx — exact basename match
 *   1xx — basename startsWith
 *   2xx — basename includes
 *   3xx — full path startsWith
 *   4xx — full path includes
 *   5xx — fuzzy subsequence in basename
 *   6xx — fuzzy subsequence in path
 *  1000 — no match
 *
 * Within each tier, depth is used as tiebreaker (shallower = better).
 */
export function rankFileResult(result: FileSearchResult, query: string): number {
  return rankWorkspaceSearchEntry(result, query);
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function parseFileResults(paths: string[]): FileSearchResult[] {
  return parseWorkspacePaths(paths);
}

// ── Standalone async search (for @-mentions, callbacks, etc.) ─────────────

/**
 * One-shot async file+folder search with ranking.
 * Returns plain `string[]` paths (dirs have trailing `/`).
 * Drop-in replacement for `findOpenCodeFiles`.
 */
export async function searchWorkspaceFiles(
  query: string,
  limit = 50,
): Promise<string[]> {
  return searchWorkspaceFilePaths(query, { limit, apiLimit: Math.max(limit, 100) });
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useWorkspaceSearch(
  query: string,
  options?: UseWorkspaceSearchOptions,
): WorkspaceSearchState {
  const serverUrl = useServerStore((state) => state.getActiveServerUrl());
  const {
    debounceMs = 150,
    maxResults = 50,
    maxTextResults = 50,
    contentSearchPrefix = '>',
    apiLimit = 100,
    minQueryLength = 1,
  } = options ?? {};

  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [textResults, setTextResults] = useState<FindMatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchedQuery, setSearchedQuery] = useState('');
  const seqRef = useRef(0);

  const trimmed = query.trim();
  const isContentSearch = trimmed.startsWith(contentSearchPrefix);
  const effectiveQuery = isContentSearch
    ? trimmed.slice(contentSearchPrefix.length).trim()
    : trimmed;

  // Debounced search effect
  useEffect(() => {
    if (!effectiveQuery || effectiveQuery.length < minQueryLength) {
      setResults([]);
      setTextResults([]);
      setSearchedQuery('');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        if (isContentSearch) {
          const matches = await findText(effectiveQuery);
          if (seq === seqRef.current) {
            setTextResults(matches.slice(0, maxTextResults));
            setResults([]);
            setSearchedQuery(effectiveQuery);
            setIsLoading(false);
          }
        } else {
          const fileResults = await searchWorkspaceFileEntries(effectiveQuery, {
            limit: maxResults,
            apiLimit,
          });

          if (seq === seqRef.current) {
            setResults(fileResults.slice(0, maxResults));
            setTextResults([]);
            setSearchedQuery(effectiveQuery);
            setIsLoading(false);
          }
        }
      } catch {
        if (seq === seqRef.current) {
          setIsLoading(false);
        }
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [effectiveQuery, isContentSearch, debounceMs, maxResults, maxTextResults, apiLimit, minQueryLength, serverUrl]);

  const hasResults = results.length > 0 || textResults.length > 0;

  return useMemo(() => ({
    results,
    textResults,
    isLoading,
    searchedQuery,
    isContentSearch,
    effectiveQuery,
    hasResults,
  }), [results, textResults, isLoading, searchedQuery, isContentSearch, effectiveQuery, hasResults]);
}
