'use client';

import { useTranslations } from 'next-intl';

import { DiffView } from '@/components/diff/diff-view';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { GitCommit } from '@/features/file-browser/types';
import { cn } from '@/lib/utils';
import { createTwoFilesPatch } from 'diff';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileEdit,
  FilePlus2,
  FileSymlink,
  FileX2,
  History,
  User,
  X,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { useFileExplorerSource } from '../explorer-source';

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { useFileCommitDiff } = useFileExplorerSource();
  const { data: diff, isLoading, error } = useFileCommitDiff(filePath, commitHash);

  if (isLoading)
    return (
      <div className="p-2">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  if (error || !diff)
    return (
      <div className="text-muted-foreground p-2 text-xs">
        {tHardcodedUi.raw(
          'featuresProjectFilesComponentsFileHistoryPopover.line72JsxTextFailedToLoadDiff',
        )}
      </div>
    );

  const statusIcon = {
    added: <FilePlus2 className="text-kortix-green size-3" />,
    modified: <FileEdit className="text-kortix-blue size-3" />,
    deleted: <FileX2 className="text-kortix-red size-3" />,
    renamed: <FileSymlink className="text-kortix-orange size-3" />,
  }[diff.status];

  const patchContent =
    diff.patch ||
    (diff.before !== undefined && diff.after !== undefined
      ? createTwoFilesPatch(filePath, filePath, diff.before, diff.after, '', '')
      : '');

  return (
    <div className="border-border/30 bg-muted/20 border-t">
      <div className="border-border/20 flex items-center gap-1.5 border-b px-2 py-1">
        {statusIcon}
        <span className="text-muted-foreground text-xs font-medium capitalize">{diff.status}</span>
        <div className="ml-auto flex items-center gap-1 text-xs tabular-nums">
          {diff.additions > 0 && <span className="text-kortix-green">+{diff.additions}</span>}
          {diff.deletions > 0 && <span className="text-kortix-red">-{diff.deletions}</span>}
        </div>
      </div>
      {patchContent ? (
        <div className="max-h-[200px] overflow-auto">
          <DiffView patch={patchContent} layout="unified" hideFileHeader />
        </div>
      ) : (
        <div className="text-muted-foreground p-2 text-center text-xs">
          {tHardcodedUi.raw(
            'featuresProjectFilesComponentsFileHistoryPopover.line102JsxTextNoDiff',
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact Commit Row
// ---------------------------------------------------------------------------

function CompactCommitRow({ commit, filePath }: { commit: GitCommit; filePath: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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

  const toggle = () => setExpanded((v) => !v);
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border transition-colors',
        expanded ? 'border-primary/30 bg-primary/5' : 'border-border/40 hover:border-border/60',
      )}
    >
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
        className="hover:bg-muted/20 focus-visible:ring-ring flex w-full cursor-pointer items-start gap-2 px-2.5 py-2 text-left outline-none focus-visible:ring-1"
      >
        <div className="mt-0.5 flex shrink-0 items-center gap-1">
          {expanded ? (
            <ChevronDown className="text-muted-foreground/50 size-3" />
          ) : (
            <ChevronRight className="text-muted-foreground/50 size-3" />
          )}
          <History className="text-primary/70 size-3.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-foreground line-clamp-1 text-xs leading-snug font-medium">
            {commit.subject}
          </p>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
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
          className="shrink-0 font-mono"
          title={tHardcodedUi.raw(
            'featuresProjectFilesComponentsFileHistoryPopover.line160JsxAttrTitleCopyCheckpointId',
          )}
        >
          {copied ? (
            <Check className="text-kortix-green size-2.5" />
          ) : (
            <Copy className="size-2.5" />
          )}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { useFileHistory } = useFileExplorerSource();
  const { data: history, isLoading, error } = useFileHistory(filePath);

  const fileName = filePath.split('/').pop() || '';
  const totalCheckpoints = history?.commits.length ?? 0;

  return (
    <div className="flex max-h-[500px] w-[420px] flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
        <History className="text-muted-foreground h-4 w-4 shrink-0" />
        <span className="flex-1 truncate text-sm font-medium">{fileName}</span>
        {totalCheckpoints > 0 && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {totalCheckpoints} version{totalCheckpoints !== 1 ? 's' : ''}
          </span>
        )}
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 overflow-hidden">
        {isLoading && (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        )}

        {!!error && !isLoading && (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertCircle className="text-muted-foreground/30 h-6 w-6" />
            <p className="text-muted-foreground text-xs">
              {error instanceof Error && error.message.includes('not a git repository')
                ? 'Not a git repository'
                : tHardcodedUi.raw(
                    'featuresProjectFilesComponentsFileHistoryPopover.line216JsxTextFailedToLoadHistory',
                  )}
            </p>
          </div>
        )}

        {!isLoading && !error && totalCheckpoints === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <History className="text-muted-foreground/20 h-6 w-6" />
            <p className="text-muted-foreground text-xs">
              {tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileHistoryPopover.line224JsxTextNoCheckpointsYet',
              )}
            </p>
          </div>
        )}

        {!isLoading && !error && totalCheckpoints > 0 && (
          <div className="space-y-1.5 p-2">
            {history!.commits.map((commit) => (
              <CompactCommitRow key={commit.hash} commit={commit} filePath={filePath} />
            ))}
            {history?.hasMore && (
              <div className="py-1 text-center">
                <span className="text-muted-foreground/50 text-xs">
                  {tHardcodedUi.raw(
                    'featuresProjectFilesComponentsFileHistoryPopover.line240JsxTextShowingTheMostRecent',
                  )}{' '}
                  {totalCheckpoints} versions
                </span>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
