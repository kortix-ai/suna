'use client';

import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { formatRelative } from '@kortix/shared';
import {
  CheckCircleIcon,
  GitDiffIcon,
  PlusIcon,
  XCircleIcon,
} from '@phosphor-icons/react';

import type { ChangeRequest, ChangeRequestStatus } from '../api/change-requests';
import { useProjectContext } from '../context';
import { useChangeRequests, usePrefetchChangeRequest } from '../hooks/use-change-requests';
import { ChangeRequestDetailDialog } from './change-request-detail-dialog';
import { OpenChangeRequestDialog } from './open-change-request-dialog';
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

const fullTimestampFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function tsFromCr(cr: ChangeRequest): number {
  if (cr.status === 'merged' && cr.merged_at) return new Date(cr.merged_at).getTime();
  if (cr.status === 'closed' && cr.closed_at) return new Date(cr.closed_at).getTime();
  return new Date(cr.created_at).getTime();
}

function crTimeLabel(cr: ChangeRequest): string {
  if (cr.status === 'merged' && cr.merged_at) {
    return `applied ${formatRelative(cr.merged_at, { extended: 'full' }) ?? ''}`;
  }
  if (cr.status === 'closed' && cr.closed_at) {
    return `dismissed ${formatRelative(cr.closed_at, { extended: 'full' }) ?? ''}`;
  }
  return `proposed ${formatRelative(cr.created_at, { extended: 'full' }) ?? ''}`;
}

/**
 * Status as a bare glyph.
 *
 * It used to sit in a `size-6 rounded-full bg-muted/40` tile — the same grey
 * for all three states, so the tile carried no information and only added a
 * shape. The colour is the signal; the icon is the label for it.
 */
function CrIcon({ status }: { status: ChangeRequestStatus }) {
  if (status === 'merged') {
    return <CheckCircleIcon weight="fill" className="text-kortix-purple size-4" />;
  }
  if (status === 'closed') return <XCircleIcon className="text-muted-foreground/60 size-4" />;
  return <GitDiffIcon className="text-kortix-green size-4" />;
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

interface ChangeRequestsPanelProps {
  open?: boolean;
  onClose: () => void;
}

/**
 * Right-edge drawer listing this project's proposed changes, filtered by
 * status. Selecting a row opens the detail dialog (diff + apply / dismiss).
 *
 * Rows prefetch their own detail and diff on hover, and the dialog seeds its
 * header straight from the row — see `usePrefetchChangeRequest` and
 * `useChangeRequest`'s `initialData` for why opening one is no longer a wait.
 */
export function ChangeRequestsPanel({ open = false, onClose }: ChangeRequestsPanelProps) {
  const ctx = useProjectContext();
  const activeRef = ctx?.ref ?? '';
  const defaultBranch = ctx?.defaultBranch ?? '';
  const [status, setStatus] = useState<ChangeRequestStatus | 'all'>('open');
  const [selectedCrId, setSelectedCrId] = useState<string | null>(null);
  const [openDialogShown, setOpenDialogShown] = useState(false);

  const { data, isLoading, error } = useChangeRequests(status, {
    enabled: open,
    refetchInterval: open ? 6_000 : undefined,
  });
  const prefetch = usePrefetchChangeRequest();

  const crs = useMemo(() => data?.change_requests ?? [], [data]);
  const groups = useMemo(() => groupByDate(crs, tsFromCr), [crs]);
  const total = crs.length;

  const initialHeadForDialog =
    activeRef && defaultBranch && activeRef !== defaultBranch ? activeRef : undefined;

  return (
    <>
      <ReviewPanel
        open={open}
        onClose={onClose}
        title="Proposed changes"
        // No refresh control: this list polls every 6s for as long as the panel
        // is open, so a manual refresh could only ever repeat what already
        // happens on its own.
        actions={
          <Hint label="Propose a change" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Propose a change"
              onClick={() => setOpenDialogShown(true)}
              className="text-muted-foreground hover:text-foreground active:scale-[0.96]"
            >
              <PlusIcon className="size-4" />
            </Button>
          </Hint>
        }
        filters={
          <Tabs
            value={status}
            onValueChange={(v) => setStatus(v as ChangeRequestStatus | 'all')}
            className="gap-0"
          >
            <TabsListCompact className="w-fit">
              <TabsTriggerCompact value="open">Open</TabsTriggerCompact>
              <TabsTriggerCompact value="merged">Applied</TabsTriggerCompact>
              <TabsTriggerCompact value="closed">Dismissed</TabsTriggerCompact>
              <TabsTriggerCompact value="all">All</TabsTriggerCompact>
            </TabsListCompact>
          </Tabs>
        }
      >
        {isLoading && <ReviewRowSkeleton count={5} />}

        {error && !isLoading && (
          <ReviewError title="Couldn't load proposed changes" error={error} />
        )}

        {!isLoading && !error && total === 0 && (
          <ReviewEmpty
            size="sm"
            className="py-10"
            icon={GitDiffIcon}
            title={status === 'open' ? 'Nothing waiting for review' : 'Nothing here yet'}
            description={
              status === 'open'
                ? 'Changes your agents propose show up here before they reach the main version.'
                : undefined
            }
            action={
              status === 'open' ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setOpenDialogShown(true)}
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                  Propose a change
                </Button>
              ) : undefined
            }
          />
        )}

        {!isLoading && !error && total > 0 && (
          <div className="pb-3">
            {groups.map((group, gi) => (
              <div key={group.label}>
                <ReviewGroupLabel first={gi === 0}>{group.label}</ReviewGroupLabel>
                {group.items.map((cr) => (
                  <ReviewRow
                    key={cr.cr_id}
                    isActive={selectedCrId === cr.cr_id}
                    onSelect={() => setSelectedCrId(cr.cr_id)}
                    onPrefetch={() => prefetch(cr.cr_id)}
                  >
                    <span className="mt-0.5 shrink-0">
                      <CrIcon status={cr.status} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-muted-foreground/70 shrink-0 text-xs tabular-nums">
                          #{cr.number}
                        </span>
                        <span
                          className={cn(
                            'text-foreground min-w-0 flex-1 truncate text-sm font-medium',
                            cr.status === 'closed' && 'text-muted-foreground',
                          )}
                        >
                          {cr.title}
                        </span>
                      </span>
                      <span
                        className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs"
                        title={fullTimestampFormat.format(tsFromCr(cr))}
                      >
                        <span className="truncate">{crTimeLabel(cr)}</span>
                        <span className="text-muted-foreground/30" aria-hidden>
                          ·
                        </span>
                        <span className="truncate">into {cr.base_ref}</span>
                      </span>
                    </span>
                  </ReviewRow>
                ))}
              </div>
            ))}
          </div>
        )}
      </ReviewPanel>

      <ChangeRequestDetailDialog crId={selectedCrId} onClose={() => setSelectedCrId(null)} />

      <OpenChangeRequestDialog
        open={openDialogShown}
        onOpenChange={setOpenDialogShown}
        projectId={ctx?.projectId ?? ''}
        defaultBranch={defaultBranch}
        initialHeadRef={initialHeadForDialog}
        onCreated={(crId) => setSelectedCrId(crId)}
      />
    </>
  );
}
