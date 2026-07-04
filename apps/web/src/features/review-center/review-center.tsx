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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { cn } from '@/lib/utils';
import type { ReviewVerdict } from '@kortix/sdk/projects-client';
import { CheckCircleSolid, InboxSolid, ShieldCheckSolid, X } from '@mynaui/icons-react';
import { ChevronDown, Layers, Search } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { statusToVerdict } from './map';
import { MOCK_ITEMS } from './mock-data';
import { type ReviewActions, ReviewDetailModal } from './review-detail-modal';
import { KIND_META, RISK_BAR, RISK_META, SOURCE_META, STATUS_META } from './review-meta';
import {
  approveAllSafe,
  bulkSetStatus,
  countsBySegment,
  decideApprovalAction,
  filterItems,
  groupBySession,
  safePendingCount,
  sessionOptions,
  setStatus,
} from './review-reducer';
import { type ReviewItem, type ReviewKind, type ReviewSegment, segmentForStatus } from './types';

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
  const reduce = useReducedMotion() ?? false;
  if (reduce) return <span className="tabular-nums">{value}</span>;
  return (
    <span className="relative inline-flex min-w-[1ch] justify-center overflow-hidden tabular-nums">
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
  fresh,
  reduce,
  onOpen,
  onToggleSelect,
}: {
  item: ReviewItem;
  idx: number;
  focused: boolean;
  selected: boolean;
  showCheck: boolean;
  /** Arrived on the last poll, not yet seen by the user. */
  fresh: boolean;
  /** prefers-reduced-motion: collapse enter/stagger to instant. */
  reduce: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
}) {
  const kind = KIND_META[item.kind];
  const Source = SOURCE_META[item.source];
  const segment = segmentForStatus(item.status);
  const risk = RISK_META[item.risk];
  // Left accent bar: kind tone by default; in Needs-you it escalates to the
  // risk tone for medium/high so risky work glows at the row's edge.
  const barClass =
    segment === 'needs_you' && (item.risk === 'medium' || item.risk === 'high')
      ? RISK_BAR[item.risk]
      : kind.bar;

  return (
    <motion.li
      data-idx={idx}
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: fresh ? -6 : 0 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduce
          ? { duration: 0 }
          : { duration: 0.15, ease: EASE, delay: fresh ? 0 : Math.min(idx * 0.012, 0.06) }
      }
      className={cn(
        'group relative flex items-center gap-3.5 py-3 pr-4 pl-5 transition-colors',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px]',
        barClass,
        focused ? 'bg-primary/[0.06] ring-kortix-blue/40 ring-1 ring-inset' : 'hover:bg-muted/40',
        selected && 'bg-primary/[0.09]',
        fresh && 'bg-kortix-blue/[0.05]',
      )}
    >
      {segment === 'needs_you' && (
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          aria-label={`Select ${item.title}`}
          className={cn(
            'shrink-0 transition-opacity',
            showCheck || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        />
      )}
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', kind.tile)}
      >
        <kind.icon className={cn('size-5', kind.iconColor)} />
      </span>

      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-kortix-blue min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
          {fresh && (
            <StatusBadge tone="info" className="shrink-0">
              New
            </StatusBadge>
          )}
          {/* Meta cluster, right-aligned to a stable column: risk (Needs-you),
              source (desktop) and time (all sizes). */}
          <span className="text-muted-foreground/70 ml-auto flex shrink-0 items-center gap-2 text-xs">
            {segment === 'needs_you' && (
              <StatusBadge
                tone={risk.tone}
                className={cn(item.risk === 'none' || item.risk === 'low' ? 'opacity-70' : '')}
              >
                {risk.label}
              </StatusBadge>
            )}
            <Source.icon className="hidden size-3 sm:block" />
            <TimeAgo iso={item.createdAt} />
          </span>
        </div>
        <div className="text-muted-foreground mt-0.5 truncate text-xs">
          <span className="text-muted-foreground/70 font-medium">{kind.label}</span>
          {item.summary ? <span className="text-muted-foreground/40"> · </span> : null}
          {item.summary}
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
  onOpenSession,
  isLoading,
  isFetching,
  sessionLabels,
}: {
  /** When provided, the inbox renders real data instead of the mock fixtures. */
  initialItems?: ReviewItem[];
  /** Connected mode: fire the server verdict for a single item. */
  onAct?: (id: string, verdict: ReviewVerdict, feedback?: string) => void;
  /** Connected mode: fire the server verdict for many items (multi-select). */
  onBulkAct?: (ids: string[], verdict: ReviewVerdict) => void;
  /** Connected mode: open a session (e.g. to watch the agent revise a change). */
  onOpenSession?: (sessionId: string) => void;
  isLoading?: boolean;
  /** A background poll is in flight — drives the "Live" refreshing affordance. */
  isFetching?: boolean;
  /** sessionId → human name, for the per-session filter + group headers. */
  sessionLabels?: Record<string, string>;
} = {}) {
  const connected = !!onAct;
  const reduce = useReducedMotion() ?? false;
  const [items, setItems] = useState<ReviewItem[]>(initialItems ?? (connected ? [] : MOCK_ITEMS));
  const [segment, setSegment] = useState<ReviewSegment>('needs_you');
  const [kindFilter, setKindFilter] = useState<ReviewKind | 'all'>('all');
  const [query, setQuery] = useState('');
  // Per-session view: filter to one session, and/or group the list by session so
  // a session's reviews + approvals sit together. Both operate on `sessionId`.
  const [sessionFilter, setSessionFilter] = useState<string | 'all'>('all');
  const [grouped, setGrouped] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedIdx, setFocusedIdx] = useState(0);
  // Only show the focused-row highlight while the user is actually navigating by
  // keyboard — otherwise the first row looks arbitrarily tinted on load.
  const [kbNav, setKbNav] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // "Fresh" = items that arrived on a poll while the user wasn't looking. We diff
  // incoming ids against the last-known set; any interaction clears the marks.
  const knownIdsRef = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const markSeen = () => setFreshIds((prev) => (prev.size ? new Set() : prev));

  const undoRef = useRef<ReviewItem[] | null>(null);
  // Query root for scroll-into-view — a container of the [data-idx] rows. It wraps
  // either the flat <ul> or the grouped <div>, so it's typed to the common base.
  const listRef = useRef<HTMLElement | null>(null);

  const labelFor = useMemo(() => (id: string) => sessionLabels?.[id], [sessionLabels]);
  const counts = useMemo(() => countsBySegment(items), [items]);
  const visible = useMemo(
    () => filterItems(items, segment, kindFilter, query, sessionFilter),
    [items, segment, kindFilter, query, sessionFilter],
  );
  const visibleSafePending = useMemo(() => safePendingCount(visible), [visible]);
  const kindCounts = useMemo(() => {
    // Respect the active session filter so the kind-tab badges never contradict
    // the visible list when scoped to one session.
    const seg = items.filter(
      (i) =>
        segmentForStatus(i.status) === segment &&
        (sessionFilter === 'all' || (i.sessionId ?? '') === sessionFilter),
    );
    const c: Partial<Record<ReviewKind | 'all', number>> = { all: seg.length };
    for (const i of seg) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items, segment, sessionFilter]);
  // Sessions available to filter by = those present in the CURRENT segment (so
  // the dropdown only offers sessions you can actually see here).
  const sessionOpts = useMemo(() => {
    const seg = items.filter((i) => segmentForStatus(i.status) === segment);
    return sessionOptions(seg, labelFor);
  }, [items, segment, labelFor]);
  // The grouped view: buckets of the currently-visible items, keyed by session.
  const groups = useMemo(() => groupBySession(visible, labelFor), [visible, labelFor]);
  // Keyboard nav + focus highlight stay keyed to the flat `visible` order even in
  // the grouped view, so j/k and the focus ring keep working — this maps an
  // item id → its flat index.
  const visibleIndexById = useMemo(() => {
    const m = new Map<string, number>();
    visible.forEach((i, idx) => m.set(i.id, idx));
    return m;
  }, [visible]);
  // If the active session filter no longer has items in this segment, reset it.
  useEffect(() => {
    if (sessionFilter !== 'all' && !sessionOpts.some((s) => s.sessionId === sessionFilter)) {
      setSessionFilter('all');
    }
  }, [sessionOpts, sessionFilter]);

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

  // Detect items that arrived since the user last looked → flag them "fresh".
  // First load seeds the known set silently (nothing is "new" on open).
  useEffect(() => {
    if (!connected) return;
    if (knownIdsRef.current === null) {
      knownIdsRef.current = new Set(items.map((i) => i.id));
      return;
    }
    const known = knownIdsRef.current;
    const arrived = items.filter((i) => !known.has(i.id)).map((i) => i.id);
    if (arrived.length > 0) {
      setFreshIds((prev) => {
        const n = new Set(prev);
        for (const id of arrived) n.add(id);
        return n;
      });
    }
    knownIdsRef.current = new Set(items.map((i) => i.id));
  }, [items, connected]);

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
    openSession: onOpenSession,
    connected,
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
      setKbNav(true);

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
          {/* Header — dropped when embedded in the customize panel (the rail
              already names the section); the standalone prototype keeps it. */}
          {!connected && (
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
          )}

          {/* Sticky controls */}
          <div
            className={cn(
              'bg-background/95 sticky top-0 z-10 space-y-3 backdrop-blur',
              connected ? 'pt-6 pb-3' : 'py-4',
            )}
          >
            <div className="flex items-center gap-3">
              <Tabs
                value={segment}
                onValueChange={(v) => {
                  setSegment(v as ReviewSegment);
                  markSeen();
                }}
                className="min-w-0 flex-1"
              >
                <TabsList type="underline" className="flex w-full items-center justify-start">
                  {SEGMENTS.map((s) => (
                    <TabsTrigger key={s.value} value={s.value} className="w-fit flex-none gap-1.5">
                      {s.label}
                      {counts[s.value] > 0 && (
                        <Badge
                          variant={
                            s.value === 'needs_you' && freshIds.size > 0 ? 'new' : 'secondary'
                          }
                          size="xs"
                        >
                          <AnimatedCount value={counts[s.value]} />
                        </Badge>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {connected && (
                <span
                  className="text-muted-foreground/70 hidden shrink-0 items-center gap-1.5 text-xs sm:flex"
                  title={isFetching ? 'Refreshing…' : 'Live — auto-updating as agents work'}
                >
                  <span
                    className={cn(
                      'bg-kortix-green size-1.5 rounded-full',
                      isFetching && !reduce && 'animate-pulse',
                    )}
                  />
                  Live
                </span>
              )}
            </div>

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

            {/* Per-session view: filter to one session, and/or group by session so
                a session's reviews + approvals sit together. Only shown once the
                current segment actually has session-linked items. */}
            {sessionOpts.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={grouped ? 'secondary' : 'outline'}
                  className="h-8 gap-1.5"
                  onClick={() => setGrouped((g) => !g)}
                  aria-pressed={grouped}
                >
                  <Layers className="size-3.5" />
                  Group by session
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant={sessionFilter === 'all' ? 'outline' : 'secondary'}
                      className="h-8 max-w-[16rem] gap-1.5"
                    >
                      <span className="truncate">
                        {sessionFilter === 'all'
                          ? 'All sessions'
                          : (sessionOpts.find((s) => s.sessionId === sessionFilter)?.label ??
                            'Session')}
                      </span>
                      <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
                    <DropdownMenuItem onClick={() => setSessionFilter('all')}>
                      All sessions
                      <Badge variant="secondary" size="xs" className="ml-auto">
                        {filterItems(items, segment, kindFilter, query, 'all').length}
                      </Badge>
                    </DropdownMenuItem>
                    {sessionOpts.map((s) => (
                      <DropdownMenuItem
                        key={s.sessionId}
                        onClick={() => setSessionFilter(s.sessionId)}
                      >
                        <span className="truncate">{s.label}</span>
                        <Badge variant="secondary" size="xs" className="ml-auto shrink-0">
                          {filterItems(items, segment, kindFilter, query, s.sessionId).length}
                        </Badge>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {/* Bulk bar (safe approvals across the current view). Prototype-only:
                connected-mode approvals are executor-adapted (exec:) and resume
                via the session's connector prompt, so there's no inbox bulk path
                to approve them yet (KORTIX-207) — hide rather than fake it. */}
            <AnimatePresence initial={false}>
              {!connected &&
                segment === 'needs_you' &&
                visibleSafePending > 0 &&
                selectionCount === 0 && (
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
          ) : grouped ? (
            <div
              ref={(el) => {
                listRef.current = el;
              }}
              onPointerMove={() => {
                setKbNav((k) => (k ? false : k));
                markSeen();
              }}
              className="space-y-4"
            >
              {groups.map((g) => (
                <div key={g.sessionId ?? '__none__'}>
                  <div className="mb-1.5 flex items-center gap-2 px-1">
                    <span className="text-foreground truncate text-xs font-semibold">
                      {g.label}
                    </span>
                    <Badge variant="secondary" size="xs">
                      {g.items.length}
                    </Badge>
                    {g.sessionId && onOpenSession && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-[11px] underline-offset-2 hover:underline"
                        onClick={() => onOpenSession(g.sessionId!)}
                      >
                        Open session
                      </button>
                    )}
                  </div>
                  <ul className="bg-popover divide-border/60 divide-y overflow-hidden rounded-lg border">
                    {g.items.map((item) => {
                      const idx = visibleIndexById.get(item.id) ?? 0;
                      return (
                        <ItemRow
                          key={item.id}
                          item={item}
                          idx={idx}
                          focused={kbNav && idx === focusedIdx}
                          selected={selectedIds.has(item.id)}
                          showCheck={selectionCount > 0}
                          fresh={freshIds.has(item.id)}
                          reduce={reduce}
                          onOpen={() => setSelectedId(item.id)}
                          onToggleSelect={() => toggleSelect(item.id)}
                        />
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <ul
              ref={(el) => {
                listRef.current = el;
              }}
              onPointerMove={() => {
                setKbNav((k) => (k ? false : k));
                markSeen();
              }}
              className="bg-popover divide-border/60 divide-y overflow-hidden rounded-lg border"
            >
              {visible.map((item, idx) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  idx={idx}
                  focused={kbNav && idx === focusedIdx}
                  selected={selectedIds.has(item.id)}
                  showCheck={selectionCount > 0}
                  fresh={freshIds.has(item.id)}
                  reduce={reduce}
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
