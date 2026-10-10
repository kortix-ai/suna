'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * The "Changes" section of a change's review page: every file the branch
 * touched, each with its live diff open underneath. Reuses the project-files
 * diff stack (DiffRenderer + useChangeRequestDiff) so the review shows the REAL
 * branch state and updates as the agent revises. Connected mode only (needs a
 * cr id + ProjectFilesProvider, which the connected inbox provides).
 */

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DiffStat } from '@/components/ui/status';
import { splitPath, splitUnifiedPatch } from '@/features/changes';
import { DiffRenderer } from '@/features/project-files/components/diff-renderer';
import { useChangeRequestDiff } from '@/features/project-files/hooks/use-change-requests';
import { cn } from '@/lib/utils';
import { CaretDownIcon as ChevronDown } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

export function ChangeFiles({ crId }: { crId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { data, isLoading, isError } = useChangeRequestDiff(crId);
  // Every file starts open — the diff is what a reviewer came for. Collapsing
  // is per file and remembered until the page is left.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const patchByPath = useMemo(() => splitUnifiedPatch(data?.patch ?? ''), [data?.patch]);

  const files = data?.files ?? [];
  const allClosed = files.length > 0 && closed.size === files.length;
  // The server could not produce patch text at all (a diff whose output
  // outgrows the API's exec buffer, or a git timeout) — the file list still
  // stands, but every body has to say so instead of staying blank.
  const patchTruncated = data?.patch_truncated === true;

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <>
        <Skeleton className="h-10 rounded-md" />
        <Skeleton className="h-24 rounded-md" />
      </>
    );
  } else if (isError || files.length === 0) {
    body = (
      <div className="bg-popover text-muted-foreground rounded-md border px-4 py-8 text-center text-sm">
        {tI18nComplete.raw('text9de1afb68dd7')}
      </div>
    );
  } else {
    body = files.map((f) => {
      const { name, dir } = splitPath(f.path);
      const patch = patchByPath.get(f.path);
      const open = !closed.has(f.path);
      return (
        <section key={f.path} className="bg-popover overflow-hidden rounded-md border">
          <button
            type="button"
            onClick={() =>
              setClosed((prev) => {
                const next = new Set(prev);
                if (next.has(f.path)) next.delete(f.path);
                else next.add(f.path);
                return next;
              })
            }
            aria-expanded={open}
            className="hover:bg-hover duration-fast flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors"
          >
            <ChevronDown
              className={cn(
                'text-muted-foreground size-3.5 shrink-0 transition-transform',
                !open && '-rotate-90',
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="text-foreground font-medium">{name}</span>
              {dir && <span className="text-muted-foreground ml-1.5">{dir}</span>}
            </span>
            <DiffStat
              additions={f.additions}
              deletions={f.deletions}
              className="shrink-0 text-xs"
            />
          </button>
          {open ? (
            patch ? (
              <div className="border-border border-t">
                <DiffRenderer patch={patch} />
              </div>
            ) : (
              <div className="border-border bg-hover/40 text-muted-foreground border-t px-4 py-3 text-center text-xs">
                {tI18nComplete.raw(
                  patchTruncated ? 'texte3d92a0125e7' : 'text903237107ab6',
                )}
              </div>
            )
          ) : null}
        </section>
      );
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('textbbd4b6a86bc6')}
        </h2>
        {files.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setClosed(allClosed ? new Set() : new Set(files.map((f) => f.path)))}
          >
            {allClosed
              ? tI18nComplete.raw('texta3e586be3eff')
              : tI18nComplete.raw('text25f7b3721119')}
          </Button>
        )}
      </div>
      <div className="space-y-2">{body}</div>
    </section>
  );
}
