'use client';

/**
 * The live "Files changed" + diff for a Change Request, embedded in the Review
 * Center's change detail. Reuses the project-files diff stack (DiffRenderer +
 * useChangeRequestDiff) so the review shows the REAL branch state — and updates
 * as the agent revises. Connected mode only (needs a cr id + ProjectFilesProvider,
 * which the connected inbox already provides; the mock has neither, so it no-ops).
 */

import { Skeleton } from '@/components/ui/skeleton';
import { DiffStat } from '@/components/ui/status';
import { DiffRenderer } from '@/features/project-files/components/diff-renderer';
import { useChangeRequestDiff } from '@/features/project-files/hooks/use-change-requests';
import { cn } from '@/lib/utils';
import { ChevronDown } from '@mynaui/icons-react';
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

const STATUS_CHAR: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
};
const STATUS_COLOR: Record<string, string> = {
  added: 'text-kortix-green',
  deleted: 'text-kortix-red',
  renamed: 'text-kortix-blue',
};

export function ChangeFilesSection({ crId }: { crId: string }) {
  const { data, isLoading, isError } = useChangeRequestDiff(crId);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const patchByPath = useMemo(() => splitPatchByFile(data?.patch ?? ''), [data?.patch]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-28 rounded" />
        <Skeleton className="h-20 rounded-lg" />
      </div>
    );
  }
  if (isError || !data || data.files.length === 0) return null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Files changed · {data.files_changed}
        </span>
        <DiffStat additions={data.additions} deletions={data.deletions} />
      </div>
      <ul className="divide-border/60 bg-popover divide-y overflow-hidden rounded-lg border">
        {data.files.map((f) => {
          const open = openPath === f.path;
          const patch = patchByPath.get(f.path);
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setOpenPath(open ? null : f.path)}
                className="hover:bg-muted/40 flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors"
              >
                <span
                  className={cn(
                    'shrink-0 font-mono text-xs font-semibold',
                    STATUS_COLOR[f.status] ?? 'text-kortix-yellow',
                  )}
                >
                  {STATUS_CHAR[f.status] ?? 'M'}
                </span>
                <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                  {f.path}
                </span>
                <DiffStat additions={f.additions} deletions={f.deletions} className="shrink-0" />
                {patch ? (
                  <ChevronDown
                    className={cn(
                      'text-muted-foreground size-3.5 shrink-0 transition-transform',
                      open && 'rotate-180',
                    )}
                  />
                ) : null}
              </button>
              {open && patch ? (
                <div className="border-border/60 max-h-[420px] overflow-auto border-t">
                  <DiffRenderer patch={patch} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
