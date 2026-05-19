'use client';

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useCommits } from '../hooks/use-commits';
import { useProjectContext } from '../context';
import { CheckpointDetailDialog } from './checkpoint-detail-dialog';
import type { ProjectCommit } from '@/lib/projects-client';

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

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
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
    else
      label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
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
        'group flex items-start gap-3 w-full pl-3 pr-2 py-2.5 text-left',
        'border-l-2 border-l-transparent',
        'hover:bg-muted/40 transition-colors',
        isActive && 'bg-primary/[0.05] border-l-primary',
      )}
    >
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary"
        title={commit.author_name}
      >
        {initials(commit.author_name)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-foreground leading-snug line-clamp-2">
          {commit.subject || '(no message)'}
        </p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate" title={commit.author_email}>
            {commit.author_name}
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span title={formatFull(ts)}>{formatRelative(ts)}</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="font-mono text-[10.5px] text-muted-foreground/70">
            {commit.short_hash}
          </span>
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
          // Same width and chrome as the Change Requests drawer below so the
          // two feel like two tabs of the same surface.
          'absolute top-0 bottom-0 right-0 w-[400px] flex flex-col',
          'border-l border-border/40 bg-background',
          'transition-transform duration-200 ease-out',
          'z-30',
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 h-12 border-b border-border/40 shrink-0">
          <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">Checkpoints</span>
          {activeRef && (
            <span
              className="flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground/90 truncate max-w-[140px]"
              title={`Version: ${activeRef}`}
            >
              <GitBranch className="h-3 w-3" />
              {activeRef}
            </span>
          )}
          {total > 0 && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {total}
              {data?.hasMore ? '+' : ''}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 ml-auto"
            onClick={() => refetch()}
            title="Refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            {isLoading && (
              <div className="p-3 space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-14 w-full rounded-md" />
                  </div>
                ))}
              </div>
            )}

            {error && !isLoading && (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <AlertCircle className="h-6 w-6 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">
                  Failed to load checkpoints
                </p>
                <p className="text-[10px] text-muted-foreground/60">
                  {error instanceof Error ? error.message : 'Unknown error'}
                </p>
              </div>
            )}

            {!isLoading && !error && total === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <GitCommitHorizontal className="h-6 w-6 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">No checkpoints yet</p>
              </div>
            )}

            {!isLoading && !error && total > 0 && (
              <div className="py-1">
                {groups.map((group, gi) => (
                  <div key={group.label}>
                    <div
                      className={cn(
                        'sticky top-0 z-[1] flex items-center gap-2 px-3 py-1.5 bg-background/95 backdrop-blur-sm',
                        'border-b border-border/40',
                        gi === 0 ? '' : 'border-t border-border/40',
                      )}
                    >
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                        {group.label}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">
                        {group.items.length}
                      </span>
                    </div>
                    <div>
                      {group.items.map((c) => (
                        <CheckpointListItem
                          key={c.hash}
                          commit={c}
                          isActive={selectedSha === c.hash}
                          onSelect={() => setSelectedSha(c.hash)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                {data?.hasMore && (
                  <div className="text-center py-2">
                    <span className="text-[10px] text-muted-foreground/50">
                      Showing the most recent {total} checkpoints
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
