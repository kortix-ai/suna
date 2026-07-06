'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { formatRelative } from '@kortix/shared';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FileDiff,
  Layers,
  Plus,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ChangeRequest, ChangeRequestStatus } from '../api/change-requests';
import { useProjectContext } from '../context';
import { useChangeRequests } from '../hooks/use-change-requests';
import { ChangeRequestDetailDialog } from './change-request-detail-dialog';
import { OpenChangeRequestDialog } from './open-change-request-dialog';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatFull(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function tsFromCr(cr: ChangeRequest): number {
  if (cr.status === 'merged' && cr.merged_at) {
    return new Date(cr.merged_at).getTime();
  }
  if (cr.status === 'closed' && cr.closed_at) {
    return new Date(cr.closed_at).getTime();
  }
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

function groupByDate(crs: ChangeRequest[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const thisWeekStart = new Date(today.getTime() - today.getDay() * 86_400_000);

  const groups = new Map<string, ChangeRequest[]>();
  for (const cr of crs) {
    const d = new Date(tsFromCr(cr));
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let label: string;
    if (day.getTime() >= today.getTime()) label = 'Today';
    else if (day.getTime() >= yesterday.getTime()) label = 'Yesterday';
    else if (day.getTime() >= thisWeekStart.getTime()) label = 'This week';
    else label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(cr);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

// ---------------------------------------------------------------------------
// list row
// ---------------------------------------------------------------------------

function CrIcon({ status }: { status: ChangeRequestStatus }) {
  if (status === 'merged') return <CheckCircle2 className="text-kortix-purple h-3.5 w-3.5" />;
  if (status === 'closed') {
    return <XCircle className="text-muted-foreground h-3.5 w-3.5" />;
  }
  return <FileDiff className="text-kortix-green h-3.5 w-3.5" />;
}

function CrListItem({
  cr,
  isActive,
  onSelect,
}: {
  cr: ChangeRequest;
  isActive: boolean;
  onSelect: () => void;
}) {
  const ts = tsFromCr(cr);
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
      <div className="bg-muted/40 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
        <CrIcon status={cr.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground font-mono text-xs">#{cr.number}</span>
          <p className="text-foreground truncate text-sm font-medium">{cr.title}</p>
        </div>
        <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <span title={formatFull(ts)}>{crTimeLabel(cr)}</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="truncate" title={`Applies to the "${cr.base_ref}" version`}>
            into {cr.base_ref}
          </span>
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

interface ChangeRequestsPanelProps {
  open?: boolean;
  onClose: () => void;
}

/**
 * Right-edge slide-in panel mirroring the Checkpoints drawer. Lists CRs for
 * the active project, filterable by status. Clicking a row opens the detail
 * dialog with diff + merge/close actions.
 */
export function ChangeRequestsPanel({ open = false, onClose }: ChangeRequestsPanelProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const ctx = useProjectContext();
  const activeRef = ctx?.ref ?? '';
  const defaultBranch = ctx?.defaultBranch ?? '';
  const [status, setStatus] = useState<ChangeRequestStatus | 'all'>('open');
  const [selectedCrId, setSelectedCrId] = useState<string | null>(null);
  const [openDialogShown, setOpenDialogShown] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useChangeRequests(status, {
    enabled: open,
    refetchInterval: open ? 6_000 : undefined,
  });
  const crs = useMemo(() => data?.change_requests ?? [], [data]);
  const groups = useMemo(() => groupByDate(crs), [crs]);
  const total = crs.length;

  const initialHeadForDialog =
    activeRef && defaultBranch && activeRef !== defaultBranch ? activeRef : undefined;

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
          <span className="text-sm font-medium">
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsChangeRequestsPanel.line131JsxTextChangeRequests',
            )}
          </span>
          {activeRef && (
            <span
              className="bg-muted/50 text-muted-foreground/90 flex max-w-[140px] items-center gap-1 truncate rounded-full px-1.5 py-0.5 text-xs"
              title={`Version: ${activeRef}`}
            >
              <Layers className="h-3 w-3" />
              {activeRef}
            </span>
          )}
          {total > 0 && <span className="text-muted-foreground text-xs tabular-nums">{total}</span>}
          <Button
            size="sm"
            className="ml-auto h-7 gap-1 px-2 text-xs"
            onClick={() => setOpenDialogShown(true)}
            title={tHardcodedUi.raw(
              'featuresProjectFilesComponentsChangeRequestsPanel.line145JsxAttrTitleOpenANewChangeRequest',
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => refetch()}
            title="Refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="border-border shrink-0 border-b px-3 py-2">
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
        </div>

        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {isLoading && (
              <div className="space-y-3 p-3">
                {Array.from({ length: 4 }).map((_, i) => (
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
                <p className="text-muted-foreground text-xs">Failed to load change requests</p>
                <p className="text-muted-foreground/60 text-xs">
                  {error instanceof Error ? error.message : 'Unknown error'}
                </p>
              </div>
            )}

            {!isLoading && !error && total === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <FileDiff className="text-muted-foreground/30 h-6 w-6" />
                <p className="text-muted-foreground text-xs">
                  {tHardcodedUi.raw(
                    'featuresProjectFilesComponentsChangeRequestsPanel.line199JsxTextChangeRequests',
                  )}
                </p>
                {status === 'open' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 h-7 gap-1 text-xs"
                    onClick={() => setOpenDialogShown(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {tHardcodedUi.raw(
                      'featuresProjectFilesComponentsChangeRequestsPanel.line209JsxTextOpenTheFirstOne',
                    )}
                  </Button>
                )}
              </div>
            )}

            {!isLoading && !error && total > 0 && (
              <div className="py-1">
                {groups.map((group, gi) => (
                  <Disclosure
                    key={group.label}
                    open
                    className="group/cr"
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
                            <ChevronDown className="size-3.5 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/cr:rotate-180" />
                          </div>
                        </div>
                      </button>
                    </DisclosureTrigger>
                    <DisclosureContent>
                      {group.items.map((cr) => (
                        <CrListItem
                          key={cr.cr_id}
                          cr={cr}
                          isActive={selectedCrId === cr.cr_id}
                          onSelect={() => setSelectedCrId(cr.cr_id)}
                        />
                      ))}
                    </DisclosureContent>
                  </Disclosure>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </aside>

      <ChangeRequestDetailDialog crId={selectedCrId} onClose={() => setSelectedCrId(null)} />

      <OpenChangeRequestDialog
        open={openDialogShown}
        onOpenChange={setOpenDialogShown}
        projectId={ctx?.projectId ?? ''}
        defaultBranch={defaultBranch}
        initialHeadRef={initialHeadForDialog}
        onCreated={(crId) => {
          setSelectedCrId(crId);
        }}
      />
    </>
  );
}
