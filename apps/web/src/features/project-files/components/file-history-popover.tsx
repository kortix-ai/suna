'use client';

import { useState, useMemo, useCallback } from 'react';
import {
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
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useFileHistory, useFileCommitDiff } from '../hooks/use-file-history';
import type { GitCommit } from '../types';
import { createTwoFilesPatch } from 'diff';
import { DiffView } from '@/components/diff/diff-view';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function formatFullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}


// ---------------------------------------------------------------------------
// Compact Commit Diff
// ---------------------------------------------------------------------------

function CompactCommitDiff({ filePath, commitHash }: { filePath: string; commitHash: string }) {
  const { data: diff, isLoading, error } = useFileCommitDiff(filePath, commitHash);

  if (isLoading) return <div className="p-2"><Skeleton className="h-16 w-full" /></div>;
  if (error || !diff) return <div className="p-2 text-xs text-muted-foreground">Failed to load diff</div>;

  const statusIcon = {
    added: <FilePlus2 className="size-3 text-emerald-500" />,
    modified: <FileEdit className="size-3 text-blue-500" />,
    deleted: <FileX2 className="size-3 text-red-500" />,
    renamed: <FileSymlink className="size-3 text-orange-500" />,
  }[diff.status];

  const patchContent = diff.patch || (
    diff.before !== undefined && diff.after !== undefined
      ? createTwoFilesPatch(filePath, filePath, diff.before, diff.after, '', '')
      : ''
  );

  return (
    <div className="border-t border-border/30 bg-muted/20">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border/20">
        {statusIcon}
        <span className="text-xs font-medium capitalize text-muted-foreground">{diff.status}</span>
        <div className="flex items-center gap-1 ml-auto text-xs">
          {diff.additions > 0 && <span className="text-emerald-500">+{diff.additions}</span>}
          {diff.deletions > 0 && <span className="text-red-500">-{diff.deletions}</span>}
        </div>
      </div>
      {patchContent ? (
        <div className="max-h-[200px] overflow-auto">
          <DiffView patch={patchContent} layout="unified" hideFileHeader />
        </div>
      ) : (
        <div className="p-2 text-xs text-muted-foreground text-center">No diff</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact Commit Row
// ---------------------------------------------------------------------------

function CompactCommitRow({ commit, filePath }: { commit: GitCommit; filePath: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyHash = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(commit.hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [commit.hash]);

  const toggle = () => setExpanded((v) => !v);
  return (
    <div className={cn('rounded-2xl border overflow-hidden transition-colors', expanded ? 'border-primary/30 bg-primary/5' : 'border-border/40 hover:border-border/60')}>
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex items-start gap-2 w-full px-2.5 py-2 text-left cursor-pointer hover:bg-muted/20 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-1 mt-0.5 shrink-0">
          {expanded ? <ChevronDown className="size-3 text-muted-foreground/50" /> : <ChevronRight className="size-3 text-muted-foreground/50" />}
          <GitCommitHorizontal className="size-3.5 text-primary/70" />
        </div>
        <div className="flex-1 min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-foreground leading-snug line-clamp-1">{commit.subject}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <User className="size-2.5" />
              {commit.author}
            </span>
            <span className="flex items-center gap-0.5" title={formatFullDate(commit.timestamp)}>
              <Clock className="size-2.5" />
              {formatRelativeDate(commit.timestamp)}
            </span>
          </div>
        </div>
        <Button
          onClick={handleCopyHash}
          variant="muted"
          size="xs"
          className="font-mono shrink-0"
          title="Copy checkpoint id"
        >
          {copied ? <Check className="size-2.5 text-emerald-500" /> : <Copy className="size-2.5" />}
          {commit.shortHash}
        </Button>
      </div>
      {expanded && <CompactCommitDiff filePath={filePath} commitHash={commit.hash} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main History Popover Content
// ---------------------------------------------------------------------------

interface FileHistoryPopoverContentProps {
  filePath: string;
  onClose: () => void;
}

export function FileHistoryPopoverContent({ filePath, onClose }: FileHistoryPopoverContentProps) {
  const { data: history, isLoading, error } = useFileHistory(filePath);

  const fileName = filePath.split('/').pop() || '';
  const totalCheckpoints = history?.commits.length ?? 0;

  return (
    <div className="flex flex-col w-[420px] max-h-[500px]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
        <History className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-medium text-sm truncate flex-1">{fileName}</span>
        {totalCheckpoints > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {totalCheckpoints} checkpoint{totalCheckpoints !== 1 ? 's' : ''}
          </span>
        )}
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 overflow-hidden">
        {isLoading && (
          <div className="p-3 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        )}

        {error && !isLoading && (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertCircle className="h-6 w-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">
              Failed to load history
            </p>
          </div>
        )}

        {!isLoading && !error && totalCheckpoints === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <GitCommitHorizontal className="h-6 w-6 text-muted-foreground/20" />
            <p className="text-xs text-muted-foreground">No checkpoints yet</p>
          </div>
        )}

        {!isLoading && !error && totalCheckpoints > 0 && (
          <div className="p-2 space-y-1.5">
            {history!.commits.map((commit) => (
              <CompactCommitRow
                key={commit.hash}
                commit={commit}
                filePath={filePath}
              />
            ))}
            {history?.hasMore && (
              <div className="text-center py-1">
                <span className="text-xs text-muted-foreground/50">
                  Showing the most recent {totalCheckpoints} checkpoints
                </span>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
