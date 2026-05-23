'use client';

import { useMemo, useState } from 'react';
import {
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  useChangeRequests,
} from '../hooks/use-change-requests';
import { useProjectContext } from '../context';
import type { ChangeRequest, ChangeRequestStatus } from '../api/change-requests';
import { ChangeRequestDetailDialog } from './change-request-detail-dialog';
import { OpenChangeRequestDialog } from './open-change-request-dialog';

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function CrIcon({ status }: { status: ChangeRequestStatus }) {
  if (status === 'merged') return <GitMerge className="h-3.5 w-3.5 text-violet-500" />;
  if (status === 'closed') return <GitPullRequestClosed className="h-3.5 w-3.5 text-muted-foreground" />;
  return <GitPullRequest className="h-3.5 w-3.5 text-emerald-500" />;
}

function CrListItem({
  cr,
  onSelect,
}: {
  cr: ChangeRequest;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="group flex items-start gap-3 w-full px-3 py-2.5 text-left cursor-pointer hover:bg-muted/40 transition-colors border-l-2 border-l-transparent"
    >
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted/40">
        <CrIcon status={cr.status} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-muted-foreground">#{cr.number}</span>
          <p className="truncate text-sm font-medium text-foreground">{cr.title}</p>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          <span className="font-mono truncate max-w-[120px]">{cr.head_ref}</span>
          <span>→</span>
          <span className="font-mono truncate max-w-[80px]">{cr.base_ref}</span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            {cr.status === 'merged' && cr.merged_at
              ? `merged ${relativeTime(cr.merged_at)}`
              : cr.status === 'closed' && cr.closed_at
                ? `closed ${relativeTime(cr.closed_at)}`
                : `opened ${relativeTime(cr.created_at)}`}
          </span>
        </div>
      </div>
    </button>
  );
}

interface ChangeRequestsPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Right-edge slide-in panel mirroring the Checkpoints drawer. Lists CRs for
 * the active project, filterable by status. Clicking a row opens the detail
 * dialog with diff + merge/close actions.
 */
export function ChangeRequestsPanel({ open, onClose }: ChangeRequestsPanelProps) {
  const ctx = useProjectContext();
  const activeRef = ctx?.ref ?? '';
  const defaultBranch = ctx?.defaultBranch ?? '';
  const [status, setStatus] = useState<ChangeRequestStatus | 'all'>('open');
  const [selectedCrId, setSelectedCrId] = useState<string | null>(null);
  const [openDialogShown, setOpenDialogShown] = useState(false);

  const { data, isLoading, refetch, isFetching } = useChangeRequests(status, {
    enabled: open,
    refetchInterval: open ? 6_000 : undefined,
  });
  const crs = useMemo(() => data?.change_requests ?? [], [data]);
  const total = crs.length;

  // If the user already has a non-default version selected, pre-fill the dialog
  // with it; otherwise leave it for them to pick.
  const initialHeadForDialog =
    activeRef && defaultBranch && activeRef !== defaultBranch ? activeRef : undefined;

  return (
    <>
      <aside
        aria-hidden={!open}
        className={cn(
          // Same width and chrome as the Checkpoints drawer so the two feel
          // like sibling surfaces. Both pinned to the right edge; the parent
          // ensures only one is open at a time.
          'absolute top-0 bottom-0 right-0 w-[400px] flex flex-col',
          'border-l border-border/40 bg-background',
          'transition-transform duration-200 ease-out',
          'z-30',
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 h-12 border-b border-border/40 shrink-0">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">Change requests</span>
          {activeRef && (
            <span
              className="flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground/90 truncate max-w-[120px]"
              title={`Version: ${activeRef}`}
            >
              <GitBranch className="h-3 w-3" />
              {activeRef}
            </span>
          )}
          <Button
            size="sm"
            className="h-7 ml-auto gap-1 px-2 text-xs"
            onClick={() => setOpenDialogShown(true)}
            title="Open a new change request"
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

        {/* Status tabs */}
        <div className="px-3 py-2 border-b border-border/40 shrink-0">
          <Tabs
            value={status}
            onValueChange={(v) => setStatus(v as ChangeRequestStatus | 'all')}
          >
            <TabsList className="h-7 w-full grid grid-cols-4 p-0.5">
              <TabsTrigger value="open" className="text-xs h-6">Open</TabsTrigger>
              <TabsTrigger value="merged" className="text-xs h-6">Merged</TabsTrigger>
              <TabsTrigger value="closed" className="text-xs h-6">Closed</TabsTrigger>
              <TabsTrigger value="all" className="text-xs h-6">All</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* List */}
        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            {isLoading && (
              <div className="p-3 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            )}
            {!isLoading && total === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <GitPullRequest className="h-6 w-6 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">
                  No {status === 'all' ? '' : status} change requests
                </p>
                {status === 'open' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 h-7 gap-1 text-xs"
                    onClick={() => setOpenDialogShown(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Open the first one
                  </Button>
                )}
              </div>
            )}
            {!isLoading && total > 0 && (
              <div className="py-1">
                {crs.map((cr) => (
                  <CrListItem
                    key={cr.cr_id}
                    cr={cr}
                    onSelect={() => setSelectedCrId(cr.cr_id)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </aside>

      <ChangeRequestDetailDialog
        crId={selectedCrId}
        onClose={() => setSelectedCrId(null)}
      />

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
