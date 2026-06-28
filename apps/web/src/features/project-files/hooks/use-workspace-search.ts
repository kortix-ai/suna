'use client';

/**
 * useWorkspaceSearch — stubbed for project-files (read-only).
 *
 * The full CMD+K palette / @-mention search is built on the OpenCode
 * find APIs which the project-files view does not have. We keep the
 * type surface stable and return empty results.
 *
 * TODO: wire to project history/search once backend supports it
 */

import { useMemo } from 'react';
import type { FindMatch } from '../types';
import {
  type WorkspaceSearchEntry,
  parseWorkspacePaths,
  rankWorkspaceSearchEntry,
} from '../search/workspace-search-core';

export type FileSearchResult = WorkspaceSearchEntry;

export interface WorkspaceSearchState {
  results: FileSearchResult[];
  textResults: FindMatch[];
  isLoading: boolean;
  searchedQuery: string;
  isContentSearch: boolean;
  effectiveQuery: string;
  hasResults: boolean;
}

export interface UseWorkspaceSearchOptions {
  debounceMs?: number;
  maxResults?: number;
  maxTextResults?: number;
  contentSearchPrefix?: string;
  apiLimit?: number;
  minQueryLength?: number;
}

export function rankFileResult(result: FileSearchResult, query: string): number {
  return rankWorkspaceSearchEntry(result, query);
}

export function parseFileResults(paths: string[]): FileSearchResult[] {
  return parseWorkspacePaths(paths);
}

export async function searchWorkspaceFiles(
  _query: string,
  _limit = 50,
): Promise<string[]> {
  return [];
}

export function useWorkspaceSearch(
  _query: string,
  _options?: UseWorkspaceSearchOptions,
): WorkspaceSearchState {
  return useMemo(
    () => ({
      results: [] as FileSearchResult[],
      textResults: [] as FindMatch[],
      isLoading: false,
      searchedQuery: '',
      isContentSearch: false,
      effectiveQuery: '',
      hasResults: false,
    }),
    [],
  );
}
