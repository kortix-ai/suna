'use client';

/**
 * Review Center — the unified human-in-the-loop inbox. One place to see what
 * finished, what changed, what needs approval, and what's waiting on a decision,
 * across web and Slack-triggered sessions.
 *
 * Built for speed: keyboard-driven (j/k, Enter, a, e, d, x, 1-3, /, ?), every
 * action is undoable, multi-select + bulk approve/dismiss, and live search.
 * Prototype: mock data, optimistic local actions. See docs/REVIEW_CENTER_DESIGN.md.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status';
import {
  Tabs,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
} from '@/components/ui/tabs';
import { infoToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import type { ReviewVerdict } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { CheckCircleSolid, InboxSolid, ShieldCheckSolid, X } from '@mynaui/icons-react';
import { Search } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { statusToVerdict } from './map';
import { MOCK_ITEMS } from './mock-data';
import { type ReviewActions, ReviewDetailModal } from './review-detail-modal';
import { KIND_META, RISK_META, SOURCE_META, STATUS_META } from './review-meta';
import {
  approveAllSafe,
  bulkSetStatus,
  countsBySegment,
  decideApprovalAction,
  filterItems,
  safePendingCount,
  setStatus,
} from './review-reducer';
import {
  type ReviewItem,
  type ReviewKind,
  type ReviewSegment,
  type ReviewStatus,
  segmentForStatus,
} from './types';

/** Calm, premium easing for the inbox's enter/exit/layout motion. */
const EASE = [0.2, 0, 0, 1] as const;

function rel(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

/**
 * Relative time is client-only: it depends on `Date.now()`, which differs between
 * the server render and hydration. Render nothing until mounted so SSR and the
 * first client render agree, then fill it in.
 */
function TimeAgo({ iso }: { iso: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <span className="tabular-nums">{mounted ? rel(iso) : ''}</span>;
}

/** A count that rolls when it changes — the satisfying tick as you clear the inbox. */
function AnimatedCount({ value }: { value: number }) {
  return (
    <span className="relative inline-flex justify-center tabular-nums">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: -7, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 7, opacity: 0 }}
          transition={{ duration: 0.16, ease: EASE }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
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

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['j', 'k'], label: 'Move down / up' },
  { keys: ['↵'], label: 'Open the focused item' },
  { keys: ['a'], label: 'Approve / ship' },
  { keys: ['e'], label: 'Ask for changes' },
  { keys: ['d'], label: 'Dismiss' },
  { keys: ['x'], label: 'Select (for bulk)' },
  { keys: ['1', '2', '3'], label: 'Switch lists' },
  { keys: ['/'], label: 'Search' },
  { keys: ['?'], label: 'This help' },
];

function ItemRow({
  item,
  idx,
  focused,
  selected,
  showCheck,
  onOpen,
  onToggleSelect,
}: {
  item: ReviewItem;
  idx: number;
  focused: boolean;
  selected: boolean;
  showCheck: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
}) {
  const kind = KIND_META[item.kind];
  const Source = SOURCE_META[item.source];
  const segment = segmentForStatus(item.status);

  return (
    <motion.li
      data-idx={idx}
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      whileTap={{ scale: 0.994 }}
      transition={{ duration: 0.18, ease: EASE, delay: Math.min(idx * 0.015, 0.08) }}
      className={cn(
        'group bg-popover flex items-center gap-3 rounded-md border px-4 py-3',
        'transition-[border-color,box-shadow,transform] duration-150 ease-out hover:-translate-y-px hover:shadow-sm',
        focused ? 'ring-1 ring-primary/20' : 'hover:border-foreground/15',
        selected && 'bg-primary/[0.04]',
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onToggleSelect}
        aria-label={`Select ${item.title}`}
        className={cn(
          'shrink-0 transition-opacity',
          showCheck || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      />
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-sm', kind.tile)}
      >
        <kind.icon className={cn('size-5', kind.iconColor)} />
      </span>

      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
          {item.risk !== 'none' && segment === 'needs_you' && (
            <StatusBadge tone={RISK_META[item.risk].tone} className="shrink-0">
              {RISK_META[item.risk].label}
            </StatusBadge>
          )}
          <span className="text-muted-foreground/60 ml-auto hidden shrink-0 items-center gap-1 text-xs sm:flex">
            <Source.icon className="size-3" />
            <TimeAgo iso={item.createdAt} />
          </span>
        </div>
        <div className="text-muted-foreground mt-0.5 truncate text-xs">{item.summary}</div>
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
    </motion.li>
  );
}

function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="lg:max-w-sm">
        <ModalHeader>
          <ModalTitle>Keyboard shortcuts</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <ul className="space-y-2">
            {SHORTCUTS.map((s) => (
              <li key={s.label} className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground text-sm">{s.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

export function ReviewCenter({
  initialItems,
  onAct,
  onBulkAct,
  isLoading,
}: {
  /** When provided, the inbox renders real data instead of the mock fixtures. */
  initialItems?: ReviewItem[];
  /** Connected mode: fire the server verdict for a single item. */
  onAct?: (id: string, verdict: ReviewVerdict, feedback?: string) => void;
  /** Connected mode: fire the server verdict for many items (multi-select). */
  onBulkAct?: (ids: string[], verdict: ReviewVerdict) => void;
  isLoading?: boolean;
} = {}) {
  const connected = !!onAct;
  const [items, setItems] = useState<ReviewItem[]>(initialItems ?? (connected ? [] : MOCK_ITEMS));
  const [segment, setSegment] = useState<ReviewSegment>('needs_you');
  const [kindFilter, setKindFilter] = useState<ReviewKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const undoRef = useRef<ReviewItem[] | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const counts = useMemo(() => countsBySegment(items), [items]);
  const visible = useMemo(
    () => filterItems(items, segment, kindFilter, query),
    [items, segment, kindFilter, query],
  );
  const visibleSafePending = useMemo(() => safePendingCount(visible), [visible]);
  const kindCounts = useMemo(() => {
    const seg = items.filter((i) => segmentForStatus(i.status) === segment);
    const c: Partial<Record<ReviewKind | 'all', number>> = { all: seg.length };
    for (const i of seg) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items, segment]);

  // Keep the focus cursor in range as the visible list changes.
  useEffect(() => {
    setFocusedIdx((i) => Math.max(0, Math.min(i, visible.length - 1)));
  }, [visible.length]);

  // Scroll the focused row into view.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${focusedIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx]);

  // Connected mode: reconcile with the server list as it (re)loads.
  useEffect(() => {
    if (initialItems) setItems(initialItems);
  }, [initialItems]);

  /** Prototype mode: optimistic change with an Undo affordance in the toast. */
  function commit(next: ReviewItem[], message: string, tone: 'success' | 'info' = 'success') {
    undoRef.current = items;
    setItems(next);
    const toastFn = tone === 'info' ? infoToast : successToast;
    toastFn(message, {
      duration: 6000,
      button: (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (undoRef.current) {
              setItems(undoRef.current);
              undoRef.current = null;
              infoToast('Restored');
            }
          }}
        >
          Undo
        </Button>
      ),
    });
  }

  /**
   * Apply an optimistic change. Connected mode fires the server mutation and
   * lets the refetch reconcile (the action is a real state change, so no local
   * Undo); prototype mode is fully local and undoable.
   */
  function apply(
    next: ReviewItem[],
    message: string,
    tone: 'success' | 'info' = 'success',
    server?: () => void,
  ) {
    if (connected) {
      setItems(next);
      server?.();
      (tone === 'info' ? infoToast : successToast)(message);
    } else {
      commit(next, message, tone);
    }
  }

  const actions: ReviewActions = {
    resolve: (id, status, message, feedback) => {
      const verdict = statusToVerdict(status);
      apply(
        setStatus(items, id, status),
        message ?? 'Updated',
        status === 'rejected' || status === 'changes_requested' ? 'info' : 'success',
        verdict && onAct ? () => onAct(id, verdict, feedback) : undefined,
      );
    },
    decideAction: (itemId, actionId, decision) =>
      setItems(decideApprovalAction(items, itemId, actionId, decision)),
    approveAllSafe: (itemId) => setItems(approveAllSafe(items, itemId)),
  };

  const quickPrimary = (item: ReviewItem) => {
    if (item.kind === 'approval' || item.kind === 'decision') {
      setSelectedId(item.id); // needs a choice — open the detail
      return;
    }
    apply(
      setStatus(items, item.id, 'approved'),
      `${item.primaryAction} · done`,
      'success',
      onAct ? () => onAct(item.id, 'approve') : undefined,
    );
  };

  const quickAskChanges = (item: ReviewItem) => {
    if (item.kind === 'change' || item.kind === 'output') {
      apply(
        setStatus(items, item.id, 'changes_requested'),
        'Sent back to the agent',
        'info',
        onAct ? () => onAct(item.id, 'changes') : undefined,
      );
    } else {
      setSelectedId(item.id);
    }
  };

  const dismissIds = (ids: string[]) => {
    if (ids.length === 0) return;
    apply(
      bulkSetStatus(items, ids, 'dismissed'),
      `Dismissed ${ids.length}`,
      'info',
      onBulkAct ? () => onBulkAct(ids, 'dismiss') : undefined,
    );
    setSelectedIds(new Set());
  };

  const approveIds = (ids: string[]) => {
    if (ids.length === 0) return;
    let next = items;
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      if (!it) continue;
      next = it.kind === 'approval' ? approveAllSafe(next, id) : setStatus(next, id, 'approved');
    }
    apply(
      next,
      `Approved ${ids.length}`,
      'success',
      onBulkAct ? () => onBulkAct(ids, 'approve') : undefined,
    );
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const onApproveAllSafeGlobal = () => {
    const ids = visible.filter((i) => i.kind === 'approval').map((i) => i.id);
    let next = items;
    for (const id of ids) next = approveAllSafe(next, id);
    commit(
      next,
      `Approved ${visibleSafePending} safe ${visibleSafePending === 1 ? 'action' : 'actions'}`,
    );
  };

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el as HTMLElement | null)?.isContentEditable;

      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (helpOpen) return setHelpOpen(false);
        if (typing) return (el as HTMLElement).blur();
        if (selectedIds.size) return setSelectedIds(new Set());
        return;
      }
      if (helpOpen || selectedId) return; // a dialog owns the keyboard
      if (typing) return; // don't hijack search typing

      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('review-search')?.focus();
        return;
      }
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        setSegment(SEGMENTS[Number(e.key) - 1].value);
        return;
      }
      if (visible.length === 0) return;
      const cur = visible[Math.min(focusedIdx, visible.length - 1)];

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIdx((i) => Math.min(visible.length - 1, i + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' || e.key === 'o') {
        e.preventDefault();
        if (cur) setSelectedId(cur.id);
      } else if (e.key === 'a') {
        if (cur) quickPrimary(cur);
      } else if (e.key === 'e') {
        if (cur) quickAskChanges(cur);
      } else if (e.key === 'd') {
        if (cur) dismissIds([cur.id]);
      } else if (e.key === 'x') {
        if (cur) {
          toggleSelect(cur.id);
          setFocusedIdx((i) => Math.min(visible.length - 1, i + 1));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selectionCount = selectedIds.size;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pb-28">
          {/* Header */}
          <header className="flex flex-col gap-2 pt-10 sm:flex-row sm:items-start sm:justify-between lg:pt-16">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="bg-kortix-base/15 flex size-7 items-center justify-center rounded-sm">
                  <InboxSolid className="text-kortix-base size-4" />
                </span>
                <h1 className="text-foreground text-xl font-medium tracking-tight text-balance">
                  Review Center
                </h1>
                {!connected && (
                  <Badge variant="beta" size="xs">
                    Prototype
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground text-sm text-balance">
                Everything that needs your eyes — changes, approvals, outputs and questions, from
                the web and Slack.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="text-muted-foreground hover:text-foreground hidden items-center gap-1.5 text-xs transition-colors sm:flex"
            >
              <Kbd>?</Kbd>
              shortcuts
            </button>
          </header>

          {/* Sticky controls */}
          <div className="bg-background/95 sticky top-0 z-10 space-y-3 py-4 backdrop-blur">
            <Tabs value={segment} onValueChange={(v) => setSegment(v as ReviewSegment)}>
              <TabsList type="underline" className="flex w-full items-center justify-start">
                {SEGMENTS.map((s) => (
                  <TabsTrigger key={s.value} value={s.value} className="w-fit flex-none gap-1.5">
                    {s.label}
                    {counts[s.value] > 0 && (
                      <Badge variant="secondary" size="xs">
                        <AnimatedCount value={counts[s.value]} />
                      </Badge>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Tabs
                value={kindFilter}
                onValueChange={(v) => setKindFilter(v as ReviewKind | 'all')}
              >
                <TabsListCompact>
                  {KIND_FILTERS.map((f) => (
                    <TabsTriggerCompact key={f.value} value={f.value}>
                      {f.label}
                      {(kindCounts[f.value] ?? 0) > 0 && (
                        <span className="ml-1 tabular-nums opacity-60">
                          <AnimatedCount value={kindCounts[f.value] ?? 0} />
                        </span>
                      )}
                    </TabsTriggerCompact>
                  ))}
                </TabsListCompact>
              </Tabs>

              <div className="relative sm:w-56">
                <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input
                  id="review-search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setFocusedIdx(0);
                  }}
                  placeholder="Search"
                  className="h-8 pl-8 text-sm"
                />
                {!query && <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>}
              </div>
            </div>

            {/* Bulk bar (safe approvals across the current view) */}
            <AnimatePresence initial={false}>
              {segment === 'needs_you' && visibleSafePending > 0 && selectionCount === 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="bg-kortix-green/10 border-kortix-green/25 flex flex-wrap items-center gap-3 rounded-md border px-4 py-2.5">
                    <ShieldCheckSolid className="text-kortix-green size-5 shrink-0" />
                    <span className="text-foreground min-w-0 flex-1 text-sm text-pretty">
                      {visibleSafePending} safe {visibleSafePending === 1 ? 'action' : 'actions'}{' '}
                      can be approved together. Risky ones stay for you to decide.
                    </span>
                    <Button size="sm" onClick={onApproveAllSafeGlobal}>
                      Approve all safe
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* List */}
          {isLoading && items.length === 0 ? (
            <ul className="space-y-2">
              {['a', 'b', 'c', 'd'].map((k) => (
                <li key={k}>
                  <Skeleton className="h-[58px] w-full rounded-md" />
                </li>
              ))}
            </ul>
          ) : visible.length === 0 ? (
            <motion.div
              key={`empty-${segment}-${query ? 'q' : ''}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: EASE }}
              className="pt-6"
            >
              <EmptyState
                icon={CheckCircleSolid}
                size="sm"
                title={
                  query
                    ? 'No matches'
                    : segment === 'needs_you'
                      ? "You're all caught up"
                      : 'Nothing here'
                }
                description={
                  query
                    ? 'Try a different search.'
                    : segment === 'needs_you'
                      ? 'When an agent needs a decision, an approval, or eyes on something it finished, it shows up here.'
                      : segment === 'waiting'
                        ? 'Items you’ve acted on that the agent is still working through will appear here.'
                        : 'Approved, rejected and finished items land here.'
                }
              />
            </motion.div>
          ) : (
            <ul ref={listRef} className="flex flex-col gap-2">
              {visible.map((item, idx) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  idx={idx}
                  focused={idx === focusedIdx}
                  selected={selectedIds.has(item.id)}
                  showCheck={selectionCount > 0}
                  onOpen={() => setSelectedId(item.id)}
                  onToggleSelect={() => toggleSelect(item.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Floating multi-select action bar */}
      <AnimatePresence>
        {selectionCount > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4"
          >
            <div className="bg-popover pointer-events-auto flex items-center gap-2 rounded-full border px-2 py-2 shadow-lg">
              <span className="text-foreground flex items-center gap-1 px-2 text-sm font-medium">
                <AnimatedCount value={selectionCount} /> selected
              </span>
              <Button size="sm" onClick={() => approveIds([...selectedIds])}>
                Approve
              </Button>
              <Button size="sm" variant="ghost" onClick={() => dismissIds([...selectedIds])}>
                Dismiss
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Clear selection"
                className="size-8"
                onClick={() => setSelectedIds(new Set())}
              >
                <X className="size-4" />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ReviewDetailModal item={selected} actions={actions} onClose={() => setSelectedId(null)} />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
