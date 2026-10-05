'use client';

import type { CaptureSearchHit, CaptureSearchKind } from '@kortix/sdk';
import { useCaptureSearch } from '@kortix/sdk/react';
import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { clockTime, shortDate } from '../capture-time';

const KINDS: readonly CaptureSearchKind[] = ['screen', 'actions', 'audio'];

/**
 * Search what was seen, done or heard on this device, newest first. A result
 * moves the playhead to its moment and closes the panel. It covers the stage
 * and the dock, like the engine window's search panel; Escape closes it.
 */
export function SearchPanel({
  projectId,
  userId,
  deviceId,
  initialQuery,
  onPick,
  onClose,
}: {
  projectId: string;
  userId: string | undefined;
  deviceId: string;
  initialQuery: string;
  onPick: (hit: CaptureSearchHit) => void;
  onClose: () => void;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  const [input, setInput] = useState(initialQuery);
  const [q, setQ] = useState(initialQuery);
  const [kinds, setKinds] = useState<CaptureSearchKind[]>([...KINDS]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(id);
  }, [input]);
  useEffect(() => inputRef.current?.focus(), []);
  const search = useCaptureSearch(
    projectId,
    q && kinds.length ? { q, kinds, userId, deviceId, limit: 50 } : null,
  );
  const hits = search.data?.hits ?? [];

  return (
    <section
      aria-label={t('search.label')}
      className="bg-background absolute inset-0 z-20 flex min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              ref={inputRef}
              aria-label={t('search.label')}
              placeholder={t('search.placeholder')}
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <InputGroupSearchClear onClick={() => setInput('')} />
          </InputGroupSearch>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t('search.close')} onClick={onClose}>
          <XIcon className="size-3.5 shrink-0" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {KINDS.map((kind) => (
          <Toggle
            key={kind}
            variant="outline"
            size="sm"
            pressed={kinds.includes(kind)}
            onPressedChange={(on) =>
              setKinds((cur) => (on ? [...cur, kind] : cur.filter((k) => k !== kind)))
            }
          >
            {t(`search.kind.${kind}`)}
          </Toggle>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!q ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('search.hint')}</p>
        ) : search.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-md" />
            ))}
          </div>
        ) : hits.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('search.none')}</p>
        ) : (
          <ul className="space-y-2" aria-label={t('search.results')}>
            {hits.map((hit) => (
              <li key={`${hit.kind}-${hit.id}`}>
                <button
                  type="button"
                  onClick={() => onPick(hit)}
                  className="bg-background hover:bg-hover flex w-full items-start gap-3 rounded-md border px-4 py-2.5 text-left transition-colors active:scale-[0.998]"
                >
                  <Badge variant="outline" size="sm" className="mt-0.5 shrink-0">
                    {t(`search.kind.${hit.kind}`)}
                  </Badge>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {[hit.app, hit.title].filter(Boolean).join(' — ') ||
                        t(`search.kind.${hit.kind}`)}
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
    </section>
  );
}
