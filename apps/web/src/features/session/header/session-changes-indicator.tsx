'use client';

/**
 * "This session has changed files" — said in the session header.
 *
 * Built to the same shape as its siblings in the trailing cluster
 * (`SessionConfigIndicator`, `SessionPendingApprovalsIndicator`): an icon
 * button with a status dot, opening a popover that states the condition and
 * carries the two things you can do about it.
 *
 * The header is one fact and one route, nothing else:
 *
 *     [tile]  3 files changed
 *             In this session  ->  main
 *
 * It used to be three overlapping sentences — a title, a subtitle and a
 * paragraph that each said "not in your <base> version yet" — which is one
 * message repeated, phrased as a negative, about a thing ("version") that is
 * not a word people use. A count, a place, and a destination say it once. The
 * base branch is a `Badge` because it is a name, not prose.
 *
 * The `A` / `M` / `D` column is `git status` shorthand, so it is a tone dot
 * plus a real word (`CHANGE_STATUS_META`) instead.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { STATUS_DOT } from '@/components/ui/status';
import { openSessionQuickView } from '@/features/session/open-session-quick-view';
import {
  CHANGE_STATUS_META,
  useOpenChangeRequest,
  useSessionBaseRef,
  useSessionChanges,
} from '@/features/session/session-changes-shared';
import { cn } from '@/lib/utils';
import { ArrowRightIcon, FilesIcon } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useState } from 'react';

/** Splits `src/app/page.tsx` into the part you read and the part you skim. */
function splitPath(path: string) {
  const name = path.split('/').pop() || path;
  const dir = path.slice(0, path.length - name.length).replace(/\/$/, '');
  return { name, dir };
}

export function SessionChangesIndicator({ sessionId }: { sessionId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  // The SAME query the tab badge and the diff panel read — one array.
  const { files: changedFiles, count: changedCount } = useSessionChanges();
  const baseRef = useSessionBaseRef(projectId, gitSessionId);
  const { asking, openChangeRequest } = useOpenChangeRequest(sessionId, baseRef);

  const [open, setOpen] = useState(false);

  if (changedCount === 0) return null;

  const fileWord = `file${changedCount === 1 ? '' : 's'}`;
  const label = `${changedCount} ${fileWord} changed in this session`;

  const viewChanges = () => {
    // `changes: true` aims this at the diff. Previously it wrote the
    // Advanced-only `viewBySession`, so in Easy the chip opened the panel on
    // the Easy home and the changes were never shown.
    openSessionQuickView('files', 'chip', { changes: true });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint side="bottom" sideOffset={4} delayDuration={300} label={label}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={label} className="relative">
            {/* A number on a 32px ghost button is a second thing to read for
                information the popover already states. The dot says "there is
                something here"; `kortix-yellow` is the pending tone. */}
            <span className="relative inline-flex">
              <FilesIcon className="text-foreground size-4" />
              <span
                className="bg-kortix-yellow ring-background absolute -top-1 -right-1 size-2 rounded-full ring-2"
                aria-hidden
              />
            </span>
          </Button>
        </PopoverTrigger>
      </Hint>

      <PopoverContent align="end" sideOffset={8} className="w-[320px] overflow-hidden p-0">
        {/* One fact, one route. The tile, the title and the route line share
            one baseline grid: `items-center` on a size-9 tile against a
            two-line block centres both against each other. */}
        <div className="border-border flex items-center gap-3 border-b px-4 py-3.5">
          <span className="bg-kortix-yellow/10 text-kortix-yellow flex size-9 shrink-0 items-center justify-center rounded-sm">
            <FilesIcon className="size-5" weight="fill" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-foreground truncate text-sm font-medium tracking-tight">
              <span className="tabular-nums">{changedCount}</span> {fileWord} changed
            </h3>
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span className="shrink-0">In this session</span>
              <ArrowRightIcon className="size-3 shrink-0 opacity-50" aria-hidden />
              <span className="sr-only">to</span>
              <Badge variant="outline" size="sm" className="max-w-32 min-w-0 font-normal">
                <span className="truncate">{baseRef}</span>
              </Badge>
            </p>
          </div>
        </div>

        <FadedScrollArea
          fadeColor="from-popover"
          rootClassName="h-auto max-h-44"
          className="max-h-44 overscroll-contain p-2 py-3"
        >
          <ul>
            {changedFiles.map((file) => {
              const meta =
                CHANGE_STATUS_META[file.status ?? 'modified'] ?? CHANGE_STATUS_META.modified;
              const { name, dir } = splitPath(file.file);
              return (
                <li
                  key={file.file}
                  title={file.file}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                >
                  <span
                    className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[meta.tone])}
                    aria-hidden
                  />
                  <span className="text-foreground/90 truncate font-medium">{name}</span>
                  <span className="sr-only">{meta.label}</span>
                  {dir && (
                    <span className="text-muted-foreground/60 ml-auto max-w-[45%] shrink-0 truncate">
                      {dir}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </FadedScrollArea>

        {/* Secondary left, primary right — the old 50/50 grid gave "look" and
            "send for review" the same weight, so neither read as the next step. */}
        <div className="border-border flex items-center justify-between gap-2 border-t px-3 py-2.5">
          <Button variant="ghost" size="sm" onClick={viewChanges}>
            {tI18nHardcoded.raw(
              'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextViewChangesaf192a3b',
            )}
          </Button>
          <Button size="sm" onClick={openChangeRequest} disabled={asking}>
            {asking ? <Loading className="size-3.5 shrink-0" /> : null}
            {tI18nHardcoded.raw(
              'autoFeaturesSessionHeaderSessionChangesIndicatorJsxTextOpenChangedc3b8624',
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
