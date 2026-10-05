'use client';

import type { CaptureSearchHit } from '@kortix/sdk';
import { useCaptureSearch } from '@kortix/sdk/react';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { clockTime, shortDate } from '../capture-time';

/**
 * Search this device: what was on screen, typed or said. Results open under
 * the field, newest first; a result moves the playhead to its moment. `/`
 * focuses the field from anywhere on the page, Escape clears and leaves it.
 */
export function DeviceSearch({
  accountId,
  userId,
  deviceId,
  onPick,
}: {
  accountId: string;
  userId: string | undefined;
  deviceId: string;
  onPick: (hit: CaptureSearchHit) => void;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(id);
  }, [input]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f')) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const search = useCaptureSearch(accountId, q ? { q, userId, deviceId, limit: 50 } : null);
  const hits = search.data?.hits ?? [];
  const pick = (hit: CaptureSearchHit) => {
    setOpen(false);
    inputRef.current?.blur();
    onPick(hit);
  };
  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (input) setInput('');
      else {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? i + 1 : i - 1;
    if (next < 0) inputRef.current?.focus();
    else rows[Math.min(rows.length - 1, next)]?.focus();
  };

  return (
    <div
      className="relative w-80 max-w-full"
      data-no-scrub
      onKeyDown={onListKey}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <InputGroupSearch>
        <InputGroupSearchIcon>
          <MagnifyingGlassIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          ref={inputRef}
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          value={input}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setInput(event.target.value);
            setOpen(true);
          }}
        />
        {input ? (
          <InputGroupSearchClear onClick={() => setInput('')} />
        ) : (
          <Kbd className="mr-2 max-sm:hidden">/</Kbd>
        )}
      </InputGroupSearch>
      {open && q ? (
        <div className="bg-popover absolute top-full right-0 z-40 mt-1 max-h-96 w-md max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border p-1 shadow-md">
          {search.isLoading ? (
            <div className="space-y-1 p-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-md" />
              ))}
            </div>
          ) : hits.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('search.none')}</p>
          ) : (
            <ul ref={listRef} aria-label={t('search.results')}>
              {hits.map((hit) => (
                <li key={`${hit.kind}-${hit.id}`}>
                  <button
                    type="button"
                    onClick={() => pick(hit)}
                    className="hover:bg-hover focus-visible:bg-hover flex w-full items-start gap-3 rounded-sm px-2 py-2 text-left outline-none"
                  >
                    <Badge variant="outline" size="xs" className="mt-0.5 shrink-0">
                      {t(`search.kind.${hit.kind}`)}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {[hit.app, hit.title].filter(Boolean).join(' · ') || t(`search.kind.${hit.kind}`)}
                      </span>
                      <span className="text-muted-foreground line-clamp-2 block text-xs wrap-anywhere">
                        {hit.snippet}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {shortDate(hit.ts, locale)} · {clockTime(hit.ts, locale)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
