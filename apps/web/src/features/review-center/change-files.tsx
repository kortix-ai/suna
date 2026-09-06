'use client';

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
import { DiffRenderer } from '@/features/project-files/components/diff-renderer';
import { useChangeRequestDiff } from '@/features/project-files/hooks/use-change-requests';
import { cn } from '@/lib/utils';
import { CaretDownIcon as ChevronDown } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

/** Split a unified diff into per-file patch chunks keyed by the new (b/) path. */
function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.trim()) continue;
    const m = chunk.match(/^diff --git a\/.*? b\/(.+?)$/m);
    if (m?.[1]) map.set(m[1].trim(), chunk);
  }
  return map;
}

/** `src/features/constant/index.ts` → name `index.ts`, dir `src/features/constant`. */
function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  if (slash < 0) return { name: path, dir: '' };
  return { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

export function ChangeFiles({ crId }: { crId: string }) {
  const { data, isLoading, isError } = useChangeRequestDiff(crId);
  // Every file starts open — the diff is what a reviewer came for. Collapsing
  // is per file and remembered until the page is left.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const patchByPath = useMemo(() => splitPatchByFile(data?.patch ?? ''), [data?.patch]);

  const files = data?.files ?? [];
  const allClosed = files.length > 0 && closed.size === files.length;

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
        No file changes to show.
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
          {open && patch ? (
            <div className="border-border border-t">
              <DiffRenderer patch={patch} />
            </div>
          ) : null}
        </section>
      );
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-foreground text-sm font-medium">Changes</h2>
        {files.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setClosed(allClosed ? new Set() : new Set(files.map((f) => f.path)))}
          >
            {allClosed ? 'Expand all' : 'Collapse all'}
          </Button>
        )}
      </div>
      <div className="space-y-2">{body}</div>
    </section>
  );
}
