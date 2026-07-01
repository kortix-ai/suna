'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import type { ProjectCommit } from '@kortix/sdk/projects-client';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useProjectContext } from '../context';
import { useCommits } from '../hooks/use-commits';
import { CheckpointDetailDialog } from './checkpoint-detail-dialog';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (weeks < 5) return `${weeks}w ago`;
  if (months < 12) return `${months}mo ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatFull(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function tsFromCommit(c: ProjectCommit): number {
  return Number(new Date(c.committed_at || c.authored_at).getTime()) || Date.now();
}

function groupByDate(commits: ProjectCommit[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const thisWeekStart = new Date(today.getTime() - today.getDay() * 86_400_000);

  const groups = new Map<string, ProjectCommit[]>();
  for (const c of commits) {
    const d = new Date(tsFromCommit(c));
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let label: string;
    if (day.getTime() >= today.getTime()) label = 'Today';
    else if (day.getTime() >= yesterday.getTime()) label = 'Yesterday';
    else if (day.getTime() >= thisWeekStart.getTime()) label = 'This week';
    else label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(c);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

// ---------------------------------------------------------------------------
// list row — minimal, Vercel-ish
// ---------------------------------------------------------------------------

function CheckpointListItem({
  commit,
  isActive,
  onSelect,
}: {
  commit: ProjectCommit;
  isActive: boolean;
  onSelect: () => void;
}) {
  const ts = tsFromCommit(commit);
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group flex w-full cursor-pointer items-start gap-3 py-2.5 pr-2 pl-3 text-left',
        'border-l-2 border-l-transparent',
        'hover:bg-muted/40 transition-colors',
        isActive && 'bg-primary/[0.05] border-l-primary',
      )}
    >
      <UserAvatar
        email={commit.author_email}
        name={commit.author_name}
        size="sm"
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-foreground line-clamp-2 text-sm leading-snug font-medium">
          {commit.subject || '(no message)'}
        </p>
        <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <span className="truncate" title={commit.author_email}>
            {commit.author_name}
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span title={formatFull(ts)}>{formatRelative(ts)}</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-muted-foreground/70 font-mono text-xs">{commit.short_hash}</span>
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

interface CheckpointsPanelProps {
  /** Controls whether the drawer is shown. Defaults to closed. */
  open?: boolean;
  onClose: () => void;
}

/**
 * Overlay drawer pinned to the right edge of its (relative) parent. The file
 * content underneath does NOT reflow when this opens — the drawer slides in
 * with a subtle shadow and stays out of the document flow.
 *
 * Caller is expected to render this inside a `position: relative` container
 * (typically the main content area of the file explorer page).
 */
export function CheckpointsPanel({ open = false, onClose }: CheckpointsPanelProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const ctx = useProjectContext();
  const activeRef = ctx?.ref ?? '';
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const { data, isLoading, error, refetch, isFetching } = useCommits({
    limit: 50,
    enabled: open,
  });

  const groups = useMemo(() => groupByDate(data?.commits ?? []), [data?.commits]);
  const total = data?.commits.length ?? 0;
  const shaList = useMemo(() => (data?.commits ?? []).map((c) => c.hash), [data?.commits]);

  return (
    <>
      <aside
        aria-hidden={!open}
        className={cn(
          'absolute top-0 right-0 bottom-0 flex w-[400px] flex-col',
          'border-border bg-background border-l',
          'transition-transform duration-200 ease-out',
          'z-30',
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
        )}
      >
        <div className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <span className="text-sm font-medium">Checkpoints</span>
          {activeRef && (
            <span
              className="bg-muted/50 text-muted-foreground/90 flex max-w-[140px] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-xs"
              title={`Version: ${activeRef}`}
            >
              <GitBranch className="h-3 w-3" />
              {activeRef}
            </span>
          )}
          {total > 0 && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {total}
              {data?.hasMore ? '+' : ''}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7"
            onClick={() => refetch()}
            title="Refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {isLoading && (
              <div className="space-y-3 p-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-14 w-full rounded-lg" />
                  </div>
                ))}
              </div>
            )}

            {error && !isLoading && (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <AlertCircle className="text-muted-foreground/30 h-6 w-6" />
                <p className="text-muted-foreground text-xs">
                  {tHardcodedUi.raw(
                    'featuresProjectFilesComponentsCheckpointsPanel.line230JsxTextFailedToLoadCheckpoints',
                  )}
                </p>
                <p className="text-muted-foreground/60 text-xs">
                  {error instanceof Error ? error.message : 'Unknown error'}
                </p>
              </div>
            )}

            {!isLoading && !error && total === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <GitCommitHorizontal className="text-muted-foreground/30 h-6 w-6" />
                <p className="text-muted-foreground text-xs">
                  {tHardcodedUi.raw(
                    'featuresProjectFilesComponentsCheckpointsPanel.line241JsxTextNoCheckpointsYet',
                  )}
                </p>
              </div>
            )}

            {!isLoading && !error && total > 0 && (
              <div className="py-1">
                {groups.map((group, gi) => (
                  <Disclosure
                    key={group.label}
                    open
                    className="group/checkpoint"
                    transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                  >
                    <DisclosureTrigger>
                      <button
                        type="button"
                        className={cn(
                          'bg-background/95 sticky top-0 z-[1] flex w-full items-center gap-2 px-3 py-1.5 backdrop-blur-sm',
                          'border-border border-b',
                          gi === 0 ? '' : 'border-border border-t',
                        )}
                      >
                        <div className="flex w-full items-center justify-between gap-2 px-1">
                          <span className="text-foreground/90 text-sm font-medium">
                            {group.label}
                          </span>
                          <div className="text-muted-foreground flex items-center gap-1.5">
                            <span className="text-[12px] tabular-nums">{group.items.length}</span>
                            <ChevronDown className="size-3.5 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/checkpoint:rotate-180" />
                          </div>
                        </div>
                      </button>
                    </DisclosureTrigger>
                    <DisclosureContent>
                      {group.items.map((c) => (
                        <CheckpointListItem
                          key={c.hash}
                          commit={c}
                          isActive={selectedSha === c.hash}
                          onSelect={() => setSelectedSha(c.hash)}
                        />
                      ))}
                    </DisclosureContent>
                  </Disclosure>
                ))}
                {data?.hasMore && (
                  <div className="py-2 text-center">
                    <span className="text-muted-foreground/50 text-xs">
                      {tHardcodedUi.raw(
                        'featuresProjectFilesComponentsCheckpointsPanel.line278JsxTextShowingTheMostRecent',
                      )}{' '}
                      {total} checkpoints
                    </span>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </div>
      </aside>

      <CheckpointDetailDialog
        sha={selectedSha}
        shaList={shaList}
        onSelectSha={setSelectedSha}
        onClose={() => setSelectedSha(null)}
      />
    </>
  );
}
