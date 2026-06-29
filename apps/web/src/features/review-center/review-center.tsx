'use client';

/**
 * Review Center — the unified human-in-the-loop inbox. One place to see what
 * finished, what changed, what needs approval, and what's waiting on a decision,
 * across web and Slack-triggered sessions. Prototype: mock data, optimistic local
 * actions. See docs/REVIEW_CENTER_DESIGN.md.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tabs,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
} from '@/components/ui/tabs';
import { infoToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { cn } from '@/lib/utils';
import { CheckCircleSolid, InboxSolid, ShieldCheckSolid } from '@mynaui/icons-react';
import { useMemo, useState } from 'react';
import { MOCK_ITEMS } from './mock-data';
import { type ReviewActions, ReviewDetailModal } from './review-detail-modal';
import { KIND_META, RISK_META, SOURCE_META, STATUS_META } from './review-meta';
import {
  approveAllSafe,
  countsBySegment,
  decideApprovalAction,
  filterItems,
  safePendingCount,
  setStatus,
} from './review-reducer';
import { type ReviewItem, type ReviewKind, type ReviewSegment, segmentForStatus } from './types';

function rel(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const SEGMENTS: { value: ReviewSegment; label: string }[] = [
  { value: 'needs_you', label: 'Needs you' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'done', label: 'Done' },
];

const KIND_FILTERS: { value: ReviewKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'change', label: 'Changes' },
  { value: 'approval', label: 'Approvals' },
  { value: 'output', label: 'Outputs' },
  { value: 'decision', label: 'Questions' },
  { value: 'batch', label: 'Finished' },
];

function ItemRow({
  item,
  onOpen,
}: {
  item: ReviewItem;
  onOpen: () => void;
}) {
  const kind = KIND_META[item.kind];
  const Source = SOURCE_META[item.source];
  const segment = segmentForStatus(item.status);

  return (
    <li className="group bg-popover hover:border-foreground/15 flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors">
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-sm', kind.tile)}
      >
        <kind.icon className={cn('size-5', kind.iconColor)} />
      </span>

      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
          {item.risk !== 'none' && segment === 'needs_you' && (
            <Badge variant={RISK_META[item.risk].badge} size="xs">
              {RISK_META[item.risk].label}
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <span className="flex items-center gap-1">
            <Source.icon className="size-3" />
            {Source.label}
          </span>
          <span className="text-muted-foreground/40">&bull;</span>
          <span className="truncate">{item.project}</span>
          <span className="text-muted-foreground/40 hidden sm:inline">&bull;</span>
          <span className="hidden shrink-0 sm:inline">{rel(item.createdAt)}</span>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        {segment === 'needs_you' ? (
          <Button size="sm" variant="secondary" onClick={onOpen}>
            {item.primaryAction}
          </Button>
        ) : (
          <Badge variant={STATUS_META[item.status].badge} size="sm">
            {STATUS_META[item.status].label}
          </Badge>
        )}
      </div>
    </li>
  );
}

export function ReviewCenter() {
  const [items, setItems] = useState<ReviewItem[]>(MOCK_ITEMS);
  const [segment, setSegment] = useState<ReviewSegment>('needs_you');
  const [kindFilter, setKindFilter] = useState<ReviewKind | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const counts = useMemo(() => countsBySegment(items), [items]);
  const visible = useMemo(
    () => filterItems(items, segment, kindFilter),
    [items, segment, kindFilter],
  );
  const visibleSafePending = useMemo(() => safePendingCount(visible), [visible]);

  const actions: ReviewActions = {
    resolve: (id, status, toast) => {
      setItems((prev) => setStatus(prev, id, status));
      if (toast)
        (status === 'rejected' || status === 'changes_requested' ? infoToast : successToast)(toast);
    },
    decideAction: (itemId, actionId, decision) =>
      setItems((prev) => decideApprovalAction(prev, itemId, actionId, decision)),
    approveAllSafe: (itemId) => setItems((prev) => approveAllSafe(prev, itemId)),
  };

  const onApproveAllSafeGlobal = () => {
    const ids = visible.filter((i) => i.kind === 'approval').map((i) => i.id);
    setItems((prev) => ids.reduce((acc, id) => approveAllSafe(acc, id), prev));
    successToast(
      `Approved ${visibleSafePending} safe ${visibleSafePending === 1 ? 'action' : 'actions'}`,
    );
  };

  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-10 pb-24 lg:py-16">
          {/* Header */}
          <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="bg-kortix-base/15 flex size-7 items-center justify-center rounded-sm">
                  <InboxSolid className="text-kortix-base size-4" />
                </span>
                <h1 className="text-foreground text-xl font-medium tracking-tight text-balance">
                  Review Center
                </h1>
                <Badge variant="beta" size="xs">
                  Prototype
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm text-balance">
                Everything that needs your eyes — changes, approvals, outputs and questions, from
                the web and Slack.
              </p>
            </div>
          </header>

          {/* Segments */}
          <Tabs value={segment} onValueChange={(v) => setSegment(v as ReviewSegment)}>
            <TabsList type="underline" className="flex w-full items-center justify-start">
              {SEGMENTS.map((s) => (
                <TabsTrigger key={s.value} value={s.value} className="w-fit flex-none gap-1.5">
                  {s.label}
                  {counts[s.value] > 0 && (
                    <Badge variant="secondary" size="xs">
                      {counts[s.value]}
                    </Badge>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* Kind filter */}
          <Tabs value={kindFilter} onValueChange={(v) => setKindFilter(v as ReviewKind | 'all')}>
            <TabsListCompact>
              {KIND_FILTERS.map((f) => (
                <TabsTriggerCompact key={f.value} value={f.value}>
                  {f.label}
                </TabsTriggerCompact>
              ))}
            </TabsListCompact>
          </Tabs>

          {/* Bulk bar */}
          {segment === 'needs_you' && visibleSafePending > 0 && (
            <div className="bg-kortix-green/10 border-kortix-green/25 flex flex-wrap items-center gap-3 rounded-md border px-4 py-2.5">
              <ShieldCheckSolid className="text-kortix-green size-5 shrink-0" />
              <span className="text-foreground min-w-0 flex-1 text-sm text-pretty">
                {visibleSafePending} safe {visibleSafePending === 1 ? 'action' : 'actions'} can be
                approved together. Risky ones stay for you to decide.
              </span>
              <Button size="sm" onClick={onApproveAllSafeGlobal}>
                Approve all safe
              </Button>
            </div>
          )}

          {/* List */}
          {visible.length === 0 ? (
            <EmptyState
              icon={CheckCircleSolid}
              size="sm"
              title={segment === 'needs_you' ? "You're all caught up" : 'Nothing here'}
              description={
                segment === 'needs_you'
                  ? 'When an agent needs a decision, an approval, or eyes on something it finished, it shows up here.'
                  : segment === 'waiting'
                    ? 'Items you’ve acted on that the agent is still working through will appear here.'
                    : 'Approved, rejected and finished items land here.'
              }
            />
          ) : (
            <ul className="space-y-2">
              {visible.map((item) => (
                <ItemRow key={item.id} item={item} onOpen={() => setSelectedId(item.id)} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <ReviewDetailModal item={selected} actions={actions} onClose={() => setSelectedId(null)} />
    </div>
  );
}
