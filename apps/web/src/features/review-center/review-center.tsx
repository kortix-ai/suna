'use client';

/**
 * Review Center — the unified human-in-the-loop inbox. One place to see what
 * finished, what changed, what needs approval, and what's waiting on a decision,
 * across web and Slack-triggered sessions.
 *
 * Built for speed: keyboard-driven (j/k, Enter, a, e, d, 1-3, /, ?), every
 * action is undoable, and live search. Multi-select left the UI on 2026-09-03;
 * the bulk plumbing (`onBulkAct`, `resolveBulkOutcome`) stays for `d`.
 * Prototype: mock data, optimistic local actions. See docs/REVIEW_CENTER_DESIGN.md.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { DiffStat } from '@/components/ui/status';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { infoToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';
import type { ReviewVerdict } from '@kortix/sdk';
import {
  ArrowUUpLeftIcon as ArrowUUpLeft,
  CheckIcon as Check,
  CheckCircleIcon as CheckCircleSolid,
  CaretDownIcon as ChevronDown,
  ClockIcon as Clock,
  DotsThreeIcon as DotsThree,
  MagnifyingGlassIcon as Search,
  XIcon as X,
} from '@phosphor-icons/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { statusToVerdict } from './map';
import { MOCK_ITEMS } from './mock-data';
import {
  bulkSkipMessage,
  formatItemAge,
  isQuickDecidableApproval,
  resolveBulkOutcome,
} from './review-actions';
import { type ReviewActions, ReviewDetail } from './review-detail';
import { KIND_META, RISK_META, STATUS_META } from './review-meta';
import {
  bulkSetStatus,
  decideApprovalAction,
  filterItems,
  groupBySession,
  sessionOptions,
  setStatus,
} from './review-reducer';
import {
  type ReviewItem,
  type ReviewKind,
  type ReviewSegment,
  type ReviewStatus,
  segmentForStatus,
} from './types';

/**
 * Relative time is client-only: it depends on `Date.now()`, which differs between
 * the server render and hydration. Render nothing until mounted so SSR and the
 * first client render agree, then fill it in.
 */
function TimeAgo({ iso }: { iso: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <span className="tabular-nums">{mounted ? formatItemAge(iso) : ''}</span>;
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
  { keys: ['1', '2', '3'], label: 'Switch lists' },
  { keys: ['/'], label: 'Search' },
  { keys: ['?'], label: 'This help' },
];

/** Flat rows, no chrome — the row itself lifts on hover/focus/select. */
const LIST_CLASS = 'space-y-1 py-2.5';

/** One small glyph after the title says where the item landed; the row
 *  carries no status badge. `needs_you` has no glyph — its action button is
 *  the state. */
const STATUS_GLYPH: Partial<Record<ReviewStatus, { icon: typeof Check; className: string }>> = {
  approved: { icon: Check, className: 'text-kortix-green' },
  done: { icon: Check, className: 'text-kortix-green' },
  waiting: { icon: Clock, className: 'text-muted-foreground' },
  changes_requested: { icon: ArrowUUpLeft, className: 'text-kortix-orange' },
  rejected: { icon: X, className: 'text-kortix-red' },
  dismissed: { icon: X, className: 'text-muted-foreground' },
};

function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground">
      •
    </span>
  );
}

function ItemRow({
  item,
  idx,
  focused,
  fresh,
  quickDecidable,
  pendingDecision,
  sessionLabel,
  onOpen,
  onQuickApprove,
  onQuickDeny,
  onAskChanges,
  onDismiss,
  onOpenSession,
}: {
  item: ReviewItem;
  idx: number;
  focused: boolean;
  /** Arrived on the last poll, not yet seen by the user. */
  fresh: boolean;
  /** Whether this row exposes inline decisions. Connector approvals are false. */
  quickDecidable: boolean;
  /** 'approve' | 'deny' while this row's own resolve mutation is in flight. */
  pendingDecision?: 'approve' | 'deny' | null;
  /** The item's originating session name, when known — shown inline so a
   *  Change Request or approval's origin is legible without opening it.
   *  Omitted in the grouped view (the session already names the group). */
  sessionLabel?: string;
  onOpen: () => void;
  onQuickApprove?: () => void;
  onQuickDeny?: () => void;
  /** Row menu — the mouse path to the `e` and `d` shortcuts. */
  onAskChanges: () => void;
  onDismiss: () => void;
  onOpenSession?: () => void;
}) {
  const kind = KIND_META[item.kind];
  const segment = segmentForStatus(item.status);
  const pending = segment === 'needs_you';
  const risky = item.risk === 'medium' || item.risk === 'high';
  const busy = !!pendingDecision;
  const number = item.kind === 'change' ? item.detail.number : undefined;
  const diff = item.kind === 'change' ? item.detail.advanced : undefined;
  const glyph = STATUS_GLYPH[item.status];
  // Meta line: when · who · where. The session stands in for the repo; when
  // the group already names it, the row's own summary fills the slot.
  const where = sessionLabel ?? item.summary;

  return (
    <li
      data-idx={idx}
      className={cn(
        'group relative flex items-center gap-3 rounded-md px-3 py-1.5',
        focused ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      {/* The leading icon names the kind by shape and the outcome by color:
          blue while it needs you, then green/orange/red/muted once decided —
          the same tone as the status check beside the title. */}
      <kind.icon
        className={cn('size-5 shrink-0', glyph ? glyph.className : kind.iconColor)}
        aria-label={kind.label}
      />

      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
          {number != null && (
            <span className="text-muted-foreground shrink-0 text-sm tabular-nums">#{number}</span>
          )}
          {glyph && (
            <Hint label={STATUS_META[item.status].label}>
              <glyph.icon
                className={cn('size-3.5 shrink-0', glyph.className)}
                aria-label={STATUS_META[item.status].label}
              />
            </Hint>
          )}
          {fresh && (
            <Badge variant="new" size="sm" className="shrink-0">
              New
            </Badge>
          )}
        </span>
        <span className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
          <TimeAgo iso={item.createdAt} />
          <Dot />
          <span className="truncate">{item.agent}</span>
          {where && (
            <>
              <Dot />
              <span className="truncate">{where}</span>
            </>
          )}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        {diff && (
          <DiffStat
            additions={diff.additions}
            deletions={diff.deletions}
            className="hidden text-xs sm:inline-flex"
          />
        )}
        {pending && risky && (
          <Badge variant={RISK_META[item.risk].badge} size="sm" className="hidden sm:inline-flex">
            {RISK_META[item.risk].label}
          </Badge>
        )}
        {pending &&
          (quickDecidable ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onQuickDeny}>
                {pendingDecision === 'deny' ? <Loading className="size-3.5 shrink-0" /> : null}
                Deny
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={onQuickApprove}>
                {pendingDecision === 'approve' ? <Loading className="size-3.5 shrink-0" /> : null}
                Approve
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={onOpen}>
              {/* "Ship it" reads as instant-merge, but this only opens the
                  detail (the modal's own button ships) — label the row
                  action for what it does: open the full diff to decide. */}
              {item.kind === 'change' ? 'Review' : item.primaryAction}
            </Button>
          ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${item.title}`}
              className="text-muted-foreground"
            >
              <DotsThree className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={onOpen}>
              Open
              <DropdownMenuShortcut>↵</DropdownMenuShortcut>
            </DropdownMenuItem>
            {onOpenSession && (
              <DropdownMenuItem onClick={onOpenSession}>Open session</DropdownMenuItem>
            )}
            {pending && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onAskChanges}>
                  Ask for changes
                  <DropdownMenuShortcut>e</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onDismiss}>
                  Dismiss
                  <DropdownMenuShortcut>d</DropdownMenuShortcut>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className={LIST_CLASS}>
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-3 py-1.5">
          <Skeleton className="size-5 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3 rounded-sm" />
            <Skeleton className="h-3 w-1/3 rounded-sm" />
          </div>
        </li>
      ))}
    </ul>
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
  onRecoverChange,
  recoveringCrId,
  onRefresh,
  isLoading,
  isFetching,
  isFetched,
  isError,
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
  /** Connected mode: start a recovery session for a conflicted change. */
  onRecoverChange?: (item: Extract<ReviewItem, { kind: 'change' }>, conflicts: string[]) => void;
  recoveringCrId?: string | null;
  /** Connected mode: force an immediate poll instead of waiting for the
   *  interval — the "Live" indicator doubles as this refresh affordance. */
  onRefresh?: () => void;
  isLoading?: boolean;
  /** A background poll is in flight — drives the "Live" refreshing affordance. */
  isFetching?: boolean;
  /** The list has been fetched at least once — until then a `?id=` in the URL
   *  holds a skeleton rather than flashing the inbox. */
  isFetched?: boolean;
  /** The initial/only load failed — show a retry state instead of an empty
   *  inbox (an empty list and a failed fetch must never look the same). */
  isError?: boolean;
  /** sessionId → human name, for the per-session filter + group headers. */
  sessionLabels?: Record<string, string>;
} = {}) {
  const connected = !!onAct;
  const [items, setItems] = useState<ReviewItem[]>(initialItems ?? (connected ? [] : MOCK_ITEMS));
  const [segment, setSegment] = useState<ReviewSegment>('needs_you');
  const [kindFilter, setKindFilter] = useState<ReviewKind | 'all'>('all');
  const [query, setQuery] = useState('');
  // Per-session view: filter to one session, and/or group the list by session so
  // a session's reviews + approvals sit together. Both operate on `sessionId`.
  const [sessionFilter, setSessionFilter] = useState<string | 'all'>('all');
  const [grouped, setGrouped] = useState(false);
  // The open review lives in the URL (`?id=<review item id>`), not in state,
  // so a refresh or a shared link lands on the same page.
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const idParam = search?.get('id') ?? null;
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
  // The single item id currently mid-mutation (row quick-decide or the detail
  // modal's approve/deny) + which verdict, so the row/modal button that fired
  // it — and only that one — shows `Loading` while connected. Cleared on the
  // next `initialItems` reconciliation (the refetch that follows a mutation).
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<'approve' | 'deny' | null>(null);

  const undoRef = useRef<ReviewItem[] | null>(null);
  // Query root for scroll-into-view — a container of the [data-idx] rows. It wraps
  // either the flat <ul> or the grouped <div>, so it's typed to the common base.
  const listRef = useRef<HTMLElement | null>(null);

  // Matched against the server list when connected: `items` (the optimistic
  // state copy) is reconciled from `initialItems` in an effect, so it lags the
  // server list by one commit — long enough for a fresh page load to see "no
  // match" once and flash the inbox before the review page.
  const sourceItems = initialItems ?? items;
  const selectedId = useMemo(
    () => (idParam && sourceItems.some((i) => i.id === idParam) ? idParam : null),
    [sourceItems, idParam],
  );
  const listLoaded = !connected || isFetched === true;
  const setSelectedId = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(search?.toString() ?? '');
      if (id) params.set('id', id);
      else params.delete('id');
      const suffix = params.toString();
      const href = suffix ? `${pathname}?${suffix}` : pathname;
      // Opening pushes so the browser's Back returns to the inbox; closing
      // replaces so Back never lands on the page you just left.
      if (id) router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, router, search],
  );
  const labelFor = useMemo(() => (id: string) => sessionLabels?.[id], [sessionLabels]);
  const visible = useMemo(
    () => filterItems(items, segment, kindFilter, query, sessionFilter),
    [items, segment, kindFilter, query, sessionFilter],
  );
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

  // Connected mode: reconcile with the server list as it (re)loads. Each
  // reconciliation is also the "settled" signal for a row/modal quick-decide
  // mutation (there's no per-call settle callback threaded through `apply`),
  // so clear the pending marker here rather than leave a button spinning
  // forever if the item already left the list (e.g. a stale poll raced it).
  useEffect(() => {
    if (initialItems) setItems(initialItems);
    setPendingId(null);
    setPendingDecision(null);
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
    const arrived: string[] = [];
    for (const item of items) {
      if (!known.has(item.id)) arrived.push(item.id);
    }
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
      if (connected && (status === 'approved' || status === 'rejected')) {
        setPendingId(id);
        setPendingDecision(status === 'approved' ? 'approve' : 'deny');
      }
      apply(
        setStatus(items, id, status),
        message ?? 'Updated',
        status === 'rejected' || status === 'changes_requested' ? 'info' : 'success',
        verdict && onAct ? () => onAct(id, verdict, feedback) : undefined,
      );
    },
    decideAction: (itemId, actionId, decision) =>
      setItems(decideApprovalAction(items, itemId, actionId, decision)),
    openSession: onOpenSession,
    recoverChange: onRecoverChange,
    recoveringCrId,
    connected,
    pendingId,
    pendingDecision,
  };

  /** Legacy quick-decision handler. The eligibility helper currently returns
   *  false because Connector approvals require the parameter-review modal. */
  const quickDecide = (item: ReviewItem, decision: 'approve' | 'deny') => {
    actions.resolve(
      item.id,
      decision === 'approve' ? 'approved' : 'rejected',
      decision === 'approve' ? 'Approved — the agent will continue' : 'Denied',
    );
  };

  const quickPrimary = (item: ReviewItem) => {
    if (connected && isQuickDecidableApproval(item)) {
      quickDecide(item, 'approve');
      return;
    }
    // Change Requests never one-click-ship from the inbox, even via the `a`
    // shortcut — merging needs the full diff in view, so this always opens
    // the detail (its "Ship it" button is the real merge action).
    if (item.kind === 'approval' || item.kind === 'decision' || item.kind === 'change') {
      setSelectedId(item.id); // needs a choice / full context — open the detail
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
    if (connected && isQuickDecidableApproval(item)) {
      quickDecide(item, 'deny');
      return;
    }
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

  /** Connected mode: decide up-front what the verdict will really act on so
   *  the optimistic removal + toast never claim more than the server was
   *  asked. Bulk verdicts skip connector approvals and Change Requests. */
  const connectedBulkOutcome = (ids: string[], verdict: 'approve' | 'dismiss') => {
    const riskById = new Map(items.map((i) => [i.id, i.risk]));
    return resolveBulkOutcome(ids, verdict, (id) => riskById.get(id));
  };

  const dismissIds = (ids: string[]) => {
    if (ids.length === 0) return;
    if (connected && onBulkAct) {
      const outcome = connectedBulkOutcome(ids, 'dismiss');
      const skipped = bulkSkipMessage(outcome);
      if (skipped) infoToast(skipped);
      if (outcome.act.length > 0) {
        apply(
          bulkSetStatus(items, outcome.act, 'dismissed'),
          `Dismissed ${outcome.act.length}`,
          'info',
          () => onBulkAct(outcome.act, 'dismiss'),
        );
      }
      return;
    }
    apply(
      bulkSetStatus(items, ids, 'dismissed'),
      `Dismissed ${ids.length}`,
      'info',
      onBulkAct ? () => onBulkAct(ids, 'dismiss') : undefined,
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

      // Every shortcut below is a BARE letter or digit, so a keystroke
      // carrying a command/control/alt modifier is never one of them — it
      // belongs to the browser, the OS, or another surface. Without this
      // guard the single-letter handlers fire alongside the real shortcut:
      // ⌘K moved the review focus up AND opened the command palette, ⌘J
      // moved it down AND started a session, and ⌘A — Select All — ran
      // `quickPrimary` on the focused item, i.e. an ACTION on a review. Added
      // when ⌘O was given to the palette's workspace switcher, which would
      // have joined that list by opening the focused review at the same time.
      //
      // Not Shift: `?` is Shift+/ and is handled immediately below.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (helpOpen) return setHelpOpen(false);
        if (typing) return (el as HTMLElement).blur();
        if (selectedId) return setSelectedId(null);
        return;
      }
      if (helpOpen || selectedId) return; // help or a review page owns the keyboard
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Prefer the optimistic copy (it carries the status you just set); fall
  // back to the server row for the one commit before the copy catches up.
  const selected = selectedId
    ? (items.find((i) => i.id === selectedId) ??
      sourceItems.find((i) => i.id === selectedId) ??
      null)
    : null;

  const renderRow = (item: ReviewItem, idx: number, inGroup: boolean) => (
    <ItemRow
      key={item.id}
      item={item}
      idx={idx}
      focused={kbNav && idx === focusedIdx}
      fresh={freshIds.has(item.id)}
      quickDecidable={connected && isQuickDecidableApproval(item)}
      pendingDecision={pendingId === item.id ? pendingDecision : null}
      sessionLabel={!inGroup && item.sessionId ? labelFor(item.sessionId) : undefined}
      onOpen={() => setSelectedId(item.id)}
      onQuickApprove={() => quickDecide(item, 'approve')}
      onQuickDeny={() => quickDecide(item, 'deny')}
      onAskChanges={() => quickAskChanges(item)}
      onDismiss={() => dismissIds([item.id])}
      onOpenSession={
        item.sessionId && onOpenSession ? () => onOpenSession(item.sessionId!) : undefined
      }
    />
  );

  const listProps = {
    ref: (el: HTMLElement | null) => {
      listRef.current = el;
    },
    onPointerMove: () => {
      setKbNav((k) => (k ? false : k));
      markSeen();
    },
  };

  const shortcutsButton = (
    <button
      type="button"
      onClick={() => setHelpOpen(true)}
      className="text-muted-foreground hover:text-foreground duration-fast hidden items-center gap-1.5 text-xs transition-colors sm:flex"
    >
      <Kbd>?</Kbd>
      Shortcuts
    </button>
  );

  // A `?id=` we cannot resolve yet: hold the row skeleton until the list has
  // fetched once, so a refresh never flashes the inbox on the way to the page.
  if (idParam && !selected && !listLoaded && !isError) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="w-full p-4">
            <ListSkeleton />
          </div>
        </div>
      </div>
    );
  }

  // The review page replaces the inbox in place — same scroll container, no
  // modal. Escape and "Back to inbox" return to the list.
  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ReviewDetail item={selected} actions={actions} onBack={() => setSelectedId(null)} />
        </div>
        <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full px-4">
          {/* One control row: what list you're in, then how to narrow it. */}
          <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
            <Tabs
              value={segment}
              onValueChange={(v) => {
                setSegment(v as ReviewSegment);
                markSeen();
              }}
              className="min-w-0"
            >
              <TabsList className="flex w-full items-center justify-start">
                {SEGMENTS.map((s) => (
                  <TabsTrigger key={s.value} value={s.value} size="sm">
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant={kindFilter === 'all' ? 'outline' : 'secondary'}>
                    {kindFilter === 'all'
                      ? 'All types'
                      : KIND_FILTERS.find((f) => f.value === kindFilter)?.label}
                    <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>Type</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={kindFilter}
                    onValueChange={(v) => setKindFilter(v as ReviewKind | 'all')}
                  >
                    {KIND_FILTERS.map((f) => (
                      <DropdownMenuRadioItem key={f.value} value={f.value} side="left">
                        {f.label}
                        {(kindCounts[f.value] ?? 0) > 0 && (
                          <Badge variant="secondary" size="xs" className="ml-auto tabular-nums">
                            {kindCounts[f.value]}
                          </Badge>
                        )}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Per-session view: filter to one session, and/or group by session
                  so a session's reviews + approvals sit together. Only shown once
                  the current segment actually has session-linked items. */}
              {sessionOpts.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant={sessionFilter === 'all' && !grouped ? 'outline' : 'secondary'}
                      className="max-w-64"
                    >
                      <span className="truncate">
                        {sessionFilter === 'all'
                          ? 'All sessions'
                          : (sessionOpts.find((s) => s.sessionId === sessionFilter)?.label ??
                            'Session')}
                      </span>
                      <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
                    <DropdownMenuLabel>Session</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={sessionFilter} onValueChange={setSessionFilter}>
                      <DropdownMenuRadioItem value="all" side="left">
                        All sessions
                        <Badge variant="secondary" size="xs" className="ml-auto tabular-nums">
                          {filterItems(items, segment, kindFilter, query, 'all').length}
                        </Badge>
                      </DropdownMenuRadioItem>
                      {sessionOpts.map((s) => (
                        <DropdownMenuRadioItem key={s.sessionId} value={s.sessionId} side="left">
                          <span className="truncate">{s.label}</span>
                          <Badge
                            variant="secondary"
                            size="xs"
                            className="ml-auto shrink-0 tabular-nums"
                          >
                            {filterItems(items, segment, kindFilter, query, s.sessionId).length}
                          </Badge>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    {/* `pl-8` lines this label up with the radio rows above: their
                        check is inline (px-2.5 + size-3.5 + gap-2), this one is
                        absolute at left-2.5, so the text needs the same start. */}
                    <DropdownMenuCheckboxItem
                      checked={grouped}
                      onCheckedChange={setGrouped}
                      className="pl-8"
                    >
                      Group by session
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <InputGroupSearch className="sm:w-56">
                <InputGroupSearchIcon>
                  <Search />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  id="review-search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setFocusedIdx(0);
                  }}
                  placeholder="Search"
                  variant="popover"
                  size="sm"
                />
                {!query && <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>}
              </InputGroupSearch>
            </div>
          </div>

          {/* List */}
          {isError && items.length === 0 ? (
            <ErrorState
              size="sm"
              title="Couldn't load the review inbox"
              description="Check your connection and try again."
              action={
                <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
                  {isFetching ? <Loading className="size-3.5 shrink-0" /> : null}
                  Retry
                </Button>
              }
            />
          ) : isLoading && items.length === 0 ? (
            <ListSkeleton />
          ) : visible.length === 0 ? (
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
          ) : grouped ? (
            <div {...listProps} className="space-y-5">
              {groups.map((g) => (
                <section key={g.sessionId ?? '__none__'} className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <h2 className="text-foreground truncate text-xs font-medium">{g.label}</h2>
                    <Badge variant="secondary" size="xs" className="tabular-nums">
                      {g.items.length}
                    </Badge>
                    {g.sessionId && onOpenSession && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground duration-fast ml-auto shrink-0 text-xs transition-colors"
                        onClick={() => onOpenSession(g.sessionId!)}
                      >
                        Open session
                      </button>
                    )}
                  </div>
                  <ul className={LIST_CLASS}>
                    {g.items.map((item) =>
                      renderRow(item, visibleIndexById.get(item.id) ?? 0, true),
                    )}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <ul {...listProps} className={LIST_CLASS}>
              {visible.map((item, idx) => renderRow(item, idx, false))}
            </ul>
          )}
        </div>
      </div>

      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
