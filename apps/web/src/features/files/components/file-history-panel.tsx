'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  ArrowLeft,
  GitCommitHorizontal,
  History,
  Loader2,
  ChevronDown,
  ChevronRight,
  User,
  Clock,
  FilePlus2,
  FileEdit,
  FileX2,
  FileSymlink,
  Copy,
  Check,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useFilesStore } from '../store/files-store';
import { useFileHistory, useFileCommitDiff } from '../hooks/use-file-history';
import type { GitCommit } from '../types';
import { createTwoFilesPatch } from 'diff';
import { DiffView } from '@/components/diff/diff-view';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a timestamp into a human-readable relative string. */
function formatRelativeDate(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
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

/** Format a timestamp into a full date string. */
function formatFullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Group commits by date (Today, Yesterday, This Week, older dates). */
function groupCommitsByDate(commits: GitCommit[]): Array<{ label: string; commits: GitCommit[] }> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const thisWeekStart = new Date(today.getTime() - today.getDay() * 86_400_000);

  const groups: Map<string, GitCommit[]> = new Map();

  for (const commit of commits) {
    const commitDate = new Date(commit.timestamp);
    const commitDay = new Date(commitDate.getFullYear(), commitDate.getMonth(), commitDate.getDate());

    let label: string;
    if (commitDay.getTime() >= today.getTime()) {
      label = 'Today';
    } else if (commitDay.getTime() >= yesterday.getTime()) {
      label = 'Yesterday';
    } else if (commitDay.getTime() >= thisWeekStart.getTime()) {
      label = 'This Week';
    } else {
      label = commitDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
      });
    }

    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label)!.push(commit);
  }

  return Array.from(groups.entries()).map(([label, commits]) => ({ label, commits }));
}


// ---------------------------------------------------------------------------
// Commit Diff Detail
// ---------------------------------------------------------------------------

function CommitDiffDetail({
  filePath,
  commitHash,
}: {
  filePath: string;
  commitHash: string;
}) {
  const { data: diff, isLoading, error } = useFileCommitDiff(filePath, commitHash);

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-xs text-muted-foreground flex items-center gap-2">
        <AlertCircle className="size-3.5" />
        Failed to load diff
      </div>
    );
  }

  if (!diff) return null;

  const statusIcon = {
    added: <FilePlus2 className="size-3.5 text-emerald-500" />,
    modified: <FileEdit className="size-3.5 text-blue-500" />,
    deleted: <FileX2 className="size-3.5 text-red-500" />,
    renamed: <FileSymlink className="size-3.5 text-orange-500" />,
  }[diff.status];

  const statusColor = {
    added: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
    modified: 'text-blue-600 dark:text-blue-400 bg-blue-500/10',
    deleted: 'text-red-600 dark:text-red-400 bg-red-500/10',
    renamed: 'text-orange-600 dark:text-orange-400 bg-orange-500/10',
  }[diff.status];

  // Use the raw patch if available, otherwise generate from before/after
  const patchContent = diff.patch || (
    diff.before !== undefined && diff.after !== undefined
      ? createTwoFilesPatch(filePath, filePath, diff.before, diff.after, '', '')
      : ''
  );

  return (
    <div className="border-t border-border/40 bg-zinc-50/50 dark:bg-zinc-900/30">
      {/* Diff stats bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
        {statusIcon}
        <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded capitalize', statusColor)}>
          {diff.status}
        </span>
        <div className="flex items-center gap-1.5 ml-auto text-xs">
          {diff.additions > 0 && (
            <span className="text-emerald-500 font-medium">+{diff.additions}</span>
          )}
          {diff.deletions > 0 && (
            <span className="text-red-500 font-medium">-{diff.deletions}</span>
          )}
        </div>
      </div>

      {/* Diff content */}
      {patchContent ? (
        <div className="max-h-[400px] overflow-auto">
          <DiffView patch={patchContent} layout="unified" hideFileHeader />
        </div>
      ) : (
        <div className="p-4 text-sm text-muted-foreground text-center">
          No diff content available
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit Card
// ---------------------------------------------------------------------------

function CommitCard({
  commit,
  filePath,
  isSelected,
  onSelect,
}: {
  commit: GitCommit;
  filePath: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyHash = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(commit.hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    },
    [commit.hash],
  );

  const handleToggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
    if (!isSelected) onSelect();
  }, [isSelected, onSelect]);

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden transition-colors',
        isSelected
          ? 'border-primary/30 bg-primary/5'
          : 'border-border/50 bg-card hover:border-border/80',
      )}
    >
      {/* Commit header */}
      <button
        onClick={handleToggleExpand}
        className="flex items-start gap-2.5 w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/30 cursor-pointer"
      >
        {/* Timeline dot + expand icon */}
        <div className="flex items-center gap-1 mt-0.5 shrink-0">
          {expanded ? (
            <ChevronDown className="size-3.5 text-muted-foreground/50" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground/50" />
          )}
          <GitCommitHorizontal className="size-4 text-primary/70" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-1">
          {/* Subject line */}
          <p className="text-sm font-medium text-foreground leading-snug line-clamp-2">
            {commit.subject}
          </p>

          {/* Meta row */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <User className="size-3" />
              {commit.author}
            </span>
            <span className="flex items-center gap-1" title={formatFullDate(commit.timestamp)}>
              <Clock className="size-3" />
              {formatRelativeDate(commit.timestamp)}
            </span>
          </div>
        </div>

        {/* Hash badge */}
        <button
          onClick={handleCopyHash}
          className={cn(
            'flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded shrink-0',
            'bg-muted/50 hover:bg-muted text-muted-foreground transition-colors',
          )}
          title="Copy commit hash"
        >
          {copied ? (
            <Check className="size-3 text-emerald-500" />
          ) : (
            <Copy className="size-3" />
          )}
          {commit.shortHash}
        </button>
      </button>

      {/* Expanded diff */}
      {expanded && (
        <CommitDiffDetail filePath={filePath} commitHash={commit.hash} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export function FileHistoryPanel() {
  const historyFilePath = useFilesStore((s) => s.historyFilePath);
  const selectedCommitHash = useFilesStore((s) => s.selectedCommitHash);
  const selectCommit = useFilesStore((s) => s.selectCommit);
  const closeHistory = useFilesStore((s) => s.closeHistory);

  const { data: history, isLoading, error } = useFileHistory(historyFilePath);

  const fileName = historyFilePath?.split('/').pop() || '';
  const groups = useMemo(
    () => (history?.commits ? groupCommitsByDate(history.commits) : []),
    [history?.commits],
  );

  const totalCommits = history?.commits.length ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={closeHistory}
          title="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <History className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium text-sm truncate">{fileName}</span>
          <span className="text-xs text-muted-foreground shrink-0">History</span>
        </div>

        {totalCommits > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {totalCommits} commit{totalCommits !== 1 ? 's' : ''}
            {history?.hasMore ? '+' : ''}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {/* Loading */}
        {isLoading && (
          <div className="p-3 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {error && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              Failed to load history
            </p>
            <p className="text-xs text-muted-foreground/60 max-w-sm">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
            {error instanceof Error && error.message.includes('not a git repository') && (
              <p className="text-xs text-muted-foreground/60">
                This project is not tracked by git.
              </p>
            )}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && totalCommits === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
            <GitCommitHorizontal className="h-8 w-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">No commit history</p>
            <p className="text-xs text-muted-foreground/50 mt-1">
              This file has no git commits yet.
            </p>
          </div>
        )}

        {/* Commit timeline */}
        {!isLoading && !error && totalCommits > 0 && historyFilePath && (
          <ScrollArea className="h-full">
            <div className="p-3 space-y-4">
              {groups.map((group) => (
                <div key={group.label}>
                  {/* Date group header */}
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                      {group.label}
                    </span>
                    <div className="flex-1 h-px bg-border/40" />
                    <span className="text-xs text-muted-foreground/40 tabular-nums">
                      {group.commits.length}
                    </span>
                  </div>

                  {/* Commits in this group */}
                  <div className="space-y-2 relative">
                    {/* Timeline line */}
                    <div className="absolute left-[18px] top-2 bottom-2 w-px bg-border/30" />

                    {group.commits.map((commit) => (
                      <CommitCard
                        key={commit.hash}
                        commit={commit}
                        filePath={historyFilePath}
                        isSelected={selectedCommitHash === commit.hash}
                        onSelect={() => selectCommit(commit.hash)}
                      />
                    ))}
                  </div>
                </div>
              ))}

              {/* Load more hint */}
              {history?.hasMore && (
                <div className="text-center py-2">
                  <span className="text-xs text-muted-foreground/50">
                    Showing first {totalCommits} commits — more available
                  </span>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Path bar */}
      {historyFilePath && (
        <div className="px-3 py-1.5 border-t text-xs text-muted-foreground truncate shrink-0 bg-muted/30">
          {historyFilePath}
        </div>
      )}
    </div>
  );
}
