'use client';

import { useTranslations } from '../../../../i18n';

import { DiffView } from '../../../../diff/diff-view';
import { Button } from '../../../../components/ui/button';
import { InlineMeta } from '../../../../components/ui/inline-meta';
import { ScrollArea } from '../../../../components/ui/scroll-area';
import { Skeleton } from '../../../../components/ui/skeleton';
import type { GitCommit } from '../../file-browser/types';
import { Copy } from '../../../../icons/copy';
import { SolidCheckIcon } from '../../icon/icons/solid-check-icon';
import { cn } from '../../../../lib/utils';
import {
  WarningCircleIcon as AlertCircle,
  ClockCounterClockwiseIcon as History,
  XIcon as X,
} from '@phosphor-icons/react';
import { createTwoFilesPatch } from 'diff';
import { useCallback, useState } from 'react';
import { useFileExplorerSource } from '../explorer-source';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared formatters, hoisted so render does not rebuild the Intl machinery
 *  per call. Same options as the old `toLocale*` calls — identical output. */
const shortDateFormatter = new Intl.DateTimeFormat();
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

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
  return shortDateFormatter.format(timestamp);
}

function formatFullDate(timestamp: number): string {
  return fullDateFormatter.format(timestamp);
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

  const patchContent =
    diff.patch ||
    (diff.before !== undefined && diff.after !== undefined
      ? createTwoFilesPatch(filePath, filePath, diff.before, diff.after, '', '')
      : '');

  return (
    <div className="space-y-1.5 px-2 pt-1 pb-2">
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
        <span className="capitalize">{diff.status}</span>
        <span className="ml-auto flex items-center gap-1.5 tabular-nums">
          {diff.additions > 0 && <span className="text-kortix-green">+{diff.additions}</span>}
          {diff.deletions > 0 && <span className="text-kortix-red">−{diff.deletions}</span>}
        </span>
      </div>
      {patchContent ? (
        <div className="border-border bg-background max-h-[220px] overflow-auto rounded-md border">
          <DiffView patch={patchContent} layout="unified" hideFileHeader />
        </div>
      ) : (
        <div className="text-muted-foreground px-1 py-2 text-xs">
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
    <li className={cn('relative rounded-md', expanded && 'bg-muted')}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        className={cn(
          'group/row focus-visible:ring-ring flex w-full cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-1',
          !expanded && 'hover:bg-muted',
        )}
      >
        {/* Timeline dot; the rail behind it is drawn by the list. */}
        <span className="border-muted-foreground bg-background relative z-10 mt-[5px] size-2.5 shrink-0 rounded-full border" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-medium">{commit.subject}</p>
          <InlineMeta className="mt-0.5">
            {commit.author}
            <time title={formatFullDate(commit.timestamp)}>
              {formatRelativeDate(commit.timestamp)}
            </time>
          </InlineMeta>
        </div>
        <button
          type="button"
          onClick={handleCopyHash}
          className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 rounded-sm px-1 font-mono text-xs leading-5"
          title={tHardcodedUi.raw(
            'featuresProjectFilesComponentsFileHistoryPopover.line160JsxAttrTitleCopyCheckpointId',
          )}
        >
          {copied ? (
            <SolidCheckIcon className="text-kortix-green size-3" />
          ) : (
            <Copy className="size-3 opacity-0 group-hover/row:opacity-100" />
          )}
          {commit.shortHash}
        </button>
      </div>
      {expanded && <CompactCommitDiff filePath={filePath} commitHash={commit.hash} />}
    </li>
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
      <div className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-3">
        <span className="flex-1 truncate text-sm font-medium">{fileName}</span>
        {totalCheckpoints > 0 && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {totalCheckpoints} {tHardcodedUi.raw('i18nComplete.text5ca4f3850ccc')}
            {totalCheckpoints !== 1 ? 's' : ''}
          </span>
        )}
        <Button variant="secondary" size="icon-sm" className="shrink-0" onClick={onClose}>
          <X className="size-3.5" />
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
              {error instanceof Error &&
              error.message.includes(tHardcodedUi.raw('i18nComplete.texte7d93eed5869'))
                ? tHardcodedUi.raw('i18nComplete.textf903b3885c5e')
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
          <div className="p-2">
            <ol className="relative space-y-0.5">
              {/* The timeline rail, through the dots' centres. */}
              <span aria-hidden className="bg-border absolute top-4 bottom-4 left-[12.5px] w-px" />
              {history!.commits.map((commit) => (
                <CompactCommitRow key={commit.hash} commit={commit} filePath={filePath} />
              ))}
            </ol>
            {history?.hasMore && (
              <div className="pt-2 text-center">
                <span className="text-muted-foreground text-xs">
                  {tHardcodedUi.raw(
                    'featuresProjectFilesComponentsFileHistoryPopover.line240JsxTextShowingTheMostRecent',
                  )}{' '}
                  {totalCheckpoints} {tHardcodedUi.raw('i18nComplete.text4612828a45f1')}
                </span>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
