'use client';

import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { UserAvatar } from '@/components/ui/user-avatar';
import type { ProjectCommit } from '@kortix/sdk';
import { ClockCounterClockwiseIcon, ArrowClockwiseIcon } from '@phosphor-icons/react';

import { useProjectContext } from '../context';
import { useCommits } from '../hooks/use-commits';
import { CheckpointDetailDialog } from './checkpoint-detail-dialog';
import {
  groupByDate,
  ReviewEmpty,
  ReviewError,
  ReviewGroupLabel,
  ReviewPanel,
  ReviewRow,
  ReviewRowSkeleton,
} from './review-panel';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Hoisted so render does not rebuild an Intl formatter per row.
const oldDateFormat = new Intl.DateTimeFormat();
const fullDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatRelative(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
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
  return oldDateFormat.format(new Date(timestamp));
}

function tsFromCommit(c: ProjectCommit): number {
  return Number(new Date(c.committed_at || c.authored_at).getTime()) || Date.now();
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
 * Right-edge drawer listing every saved version of the active ref, newest
 * first. Selecting a row opens the checkpoint detail dialog.
 *
 * Shares its chrome with `ChangeRequestsPanel` through `ReviewPanel` — the two
 * were near-identical copies that had drifted apart.
 *
 * Caller is expected to render this inside a `position: relative` container
 * (typically the main content area of the file explorer page); the drawer
 * overlays that area rather than reflowing it.
 */
export function CheckpointsPanel({ open = false, onClose }: CheckpointsPanelProps) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const { data, isLoading, error, refetch, isFetching } = useCommits({ limit: 50, enabled: open });

  const commits = useMemo(() => data?.commits ?? [], [data?.commits]);
  const groups = useMemo(() => groupByDate(commits, tsFromCommit), [commits]);
  const total = commits.length;
  const shaList = useMemo(() => commits.map((c) => c.hash), [commits]);

  return (
    <>
      <ReviewPanel
        open={open}
        onClose={onClose}
        title="Version history"
        // Unlike the proposed-changes list this one does not poll
        // (`useCommits` is `staleTime: 30s`, no interval), so a manual refresh
        // is the only way to pull a checkpoint that landed while it was open.
        actions={
          <Hint label="Refresh" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              onClick={() => refetch()}
              disabled={isFetching}
              className="text-muted-foreground hover:text-foreground active:scale-[0.96]"
            >
              {isFetching ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <ArrowClockwiseIcon className="size-4" />
              )}
            </Button>
          </Hint>
        }
      >
        {isLoading && <ReviewRowSkeleton count={7} />}

        {error && !isLoading && <ReviewError title="Couldn't load version history" error={error} />}

        {!isLoading && !error && total === 0 && (
          <ReviewEmpty
            size="sm"
            className="py-10"
            icon={ClockCounterClockwiseIcon}
            title="No saved versions yet"
            description="Every time your agents save work, that version appears here."
          />
        )}

        {!isLoading && !error && total > 0 && (
          <div className="pb-3">
            {groups.map((group, gi) => (
              <div key={group.label}>
                <ReviewGroupLabel first={gi === 0}>{group.label}</ReviewGroupLabel>
                {group.items.map((c) => {
                  const ts = tsFromCommit(c);
                  return (
                    <ReviewRow
                      key={c.hash}
                      isActive={selectedSha === c.hash}
                      onSelect={() => setSelectedSha(c.hash)}
                    >
                      <UserAvatar
                        email={c.author_email}
                        name={c.author_name}
                        size="sm"
                        className="mt-0.5 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground line-clamp-2 text-sm leading-snug font-medium">
                          {c.subject || '(no message)'}
                        </span>
                        <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                          <span className="truncate" title={c.author_email}>
                            {c.author_name}
                          </span>
                          <span className="text-muted-foreground/30" aria-hidden>
                            ·
                          </span>
                          <span className="shrink-0" title={fullDateTimeFormat.format(ts)}>
                            {formatRelative(ts)}
                          </span>
                        </span>
                      </span>
                    </ReviewRow>
                  );
                })}
              </div>
            ))}
            {data?.hasMore && (
              <p className="text-muted-foreground/60 px-3 pt-4 text-xs">
                Showing the {total} most recent versions.
              </p>
            )}
          </div>
        )}
      </ReviewPanel>

      <CheckpointDetailDialog
        sha={selectedSha}
        shaList={shaList}
        onSelectSha={setSelectedSha}
        onClose={() => setSelectedSha(null)}
      />
    </>
  );
}
