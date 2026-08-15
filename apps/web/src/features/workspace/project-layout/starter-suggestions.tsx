'use client';

import { ArrowUpRightIcon, ShuffleIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { StarterSuggestionsResponse } from '@kortix/sdk';
import { useProjectStarterSuggestions } from '@kortix/sdk/react';
import { STARTER_PROMPT_FALLBACKS } from '@kortix/shared';

import { nextPage, pageCount, sliceForPage } from './starter-suggestions-logic';

const PAGE_SIZE = 3;

// Same shape as the live SDK response's items — carries `label` even though
// the row renderer below only ever shows `prompt`, so the fallback pool
// isn't silently narrower than what `useProjectStarterSuggestions` returns.
type SuggestionItem = StarterSuggestionsResponse['items'][number];

const FALLBACK_POOL: SuggestionItem[] = STARTER_PROMPT_FALLBACKS.map(({ id, label, prompt }) => ({
  id,
  label,
  prompt,
}));

/**
 * Starter-suggestion rows shown under the hero composer — quiet Perplexity/
 * Sana-style rows (arrow tile + prompt text) with a small Shuffle beneath
 * that rotates through 3-item slices of the pool. One visual system for both
 * the personalized and static states: while loading or on error this renders
 * the same static fallback texts the server would otherwise send, so there is
 * no flash, no spinner, and no layout shift when the personalized set lands.
 */
export function StarterSuggestions({
  projectId,
  onPick,
}: {
  projectId: string;
  onPick: (text: string) => void;
}) {
  const { data } = useProjectStarterSuggestions(projectId);
  const pool: SuggestionItem[] = data?.items ?? FALLBACK_POOL;

  const [page, setPage] = useState(0);
  const pages = pageCount(pool.length, PAGE_SIZE);
  // Clamp instead of resetting on every pool-identity change — the
  // personalized set can land while the user is mid-read; only snap back
  // when the current page no longer exists in the new pool.
  const activePage = Math.min(page, Math.max(pages - 1, 0));
  const items = sliceForPage(pool, activePage, PAGE_SIZE);

  if (items.length === 0) return null;

  return (
    <div className="flex w-full max-w-[40rem] flex-col items-center gap-1">
      <div key={activePage} className="animate-in fade-in slide-in-from-bottom-1 w-full duration-150">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(item.prompt)}
            className={cn(
              'flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left',
              'hover:bg-muted/60 transition-colors duration-150 active:scale-[0.99]',
            )}
          >
            <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
              <ArrowUpRightIcon className="text-muted-foreground size-3.5" aria-hidden />
            </span>
            <span className="text-foreground/90 line-clamp-2 text-sm leading-snug">
              {item.prompt}
            </span>
          </button>
        ))}
      </div>
      {pages > 1 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Show different suggestions"
          onClick={() => setPage(nextPage(activePage, pages))}
          className="gap-1.5"
        >
          <ShuffleIcon className="size-3.5" aria-hidden />
          Shuffle
        </Button>
      ) : null}
    </div>
  );
}
