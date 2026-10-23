'use client';

import { useTranslations } from '../../i18n';
/**
 * Review Center — the unified human-in-the-loop inbox. One place to see what
 * finished, what changed, what needs approval, and what's waiting on a decision,
 * across web and Slack-triggered sessions.
 *
 * Built for speed: keyboard-driven (j/k, Enter, a, e, d, x, 1-3, /, ?), every
 * action is undoable, and live search. In Needs you, a row's checkbox (on
 * hover) or `x` starts select mode: the floating bar approves, denies or
 * dismisses up to 50 items through `onBulkAct`.
 * Prototype: mock data, optimistic local actions.
 */

import { Badge } from '../../primitives/badge';
import { Checkbox } from '../../primitives/checkbox';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { CountBadge } from '../../primitives/count-badge';
import { Button } from '../../primitives/button';
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
} from '../../primitives/dropdown-menu';
import Hint from '../../primitives/hint';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Kbd } from '../../primitives/kbd';
import Loading from '../../primitives/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '../../primitives/modal';
import { Skeleton } from '../../primitives/skeleton';
import { DiffStat } from '../../primitives/status';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import {
  errorToast,
  infoToast,
  successToast,
  toastIcon,
  undoToast,
} from '../../primitives/toast';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { localizeUiCatalog } from '../../i18n/ui-catalog/localize-ui-catalog';
import { PRODUCT_CATALOG_TRANSLATION_KEYS } from '../../i18n/ui-catalog/product-catalog-translation-keys.generated';
import { cn } from '../../internal/lib/utils';
import { hasOpenFloatingLayer } from '../../lib/z-stack';
import { SelectionBar, type SelectionBarAction } from '../../internal/selection/selection-bar';
import { selectRange, toggleId } from '../../internal/selection/selection';
import type { ReviewVerdict } from '@kortix/sdk';
import {
  ArrowUUpLeftIcon as ArrowUUpLeft,
  CheckIcon as Check,
  CheckCircleIcon as CheckCircleSolid,
  CheckSquareIcon,
  CaretDownIcon as ChevronDown,
  ClockIcon as Clock,
  DotsThreeIcon as DotsThree,
  MagnifyingGlassIcon as Search,
  WarningIcon,
  XIcon as X,
} from '@phosphor-icons/react';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { statusToVerdict } from './map';
import { getLocalizedMockItems } from './mock-data';
import {
  BULK_MAX,
  BULK_VERDICT,
  type BulkResult,
  type BulkVerb,
  bulkResultMessage,
  bulkSelectable,
  bulkSkipMessage,
  bulkSupports,
  formatExpiresIn,
  formatItemAge,
  isQuickDecidableApproval,
  resolveBulkOutcome,
} from './review-actions';
import { reviewArgsSummary } from '../../session/prompts/session-approval-review';
import { approvalIdentity } from '../../markdown/setup-links/approval-decision';
import { ConnectorAppMark } from '../../markdown/setup-links/connector-handshake';
import {
  ApprovalDecisionModal,
  reviewApprovalAsker,
  reviewApprovalDenyOnly,
  reviewApprovalDetails,
} from './approval-modal';
import { type ReviewActions, ReviewDetail } from './review-detail';
import {
  KIND_META,
  reviewKindLabel,
  reviewStatusLabel,
} from './review-meta';
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
  type ReviewRisk,
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

/** "Expires in 3h" on a pending approval. Under one hour a clock glyph in the
 *  warning accent leads it; the text stays muted (an accent paints a glyph,
 *  never text). Client-only, like `TimeAgo`. Nothing once no time is left. */
function ExpiresIn({ iso }: { iso: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const left = mounted ? formatExpiresIn(iso) : null;
  if (!left) return null;
  return (
    <>
      <Dot />
      {left.soon ? (
        <Clock aria-hidden className="text-kortix-orange size-3.5 shrink-0" />
      ) : null}
      <span className="shrink-0 tabular-nums">
        {tHardcodedUi('approvalPage.expiresIn', { time: left.time })}
      </span>
    </>
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
  expired: { icon: Clock, className: 'text-muted-foreground' },
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
  sessionLabel,
  onOpen,
  onAskChanges,
  onDismiss,
  onOpenSession,
  selection,
}: {
  item: ReviewItem;
  idx: number;
  focused: boolean;
  /** Arrived on the last poll, not yet seen by the user. */
  fresh: boolean;
  /** The item's originating session name, when known — shown inline so a
   *  Change Request or approval's origin is legible without opening it.
   *  Omitted in the grouped view (the session already names the group). */
  sessionLabel?: string;
  onOpen: () => void;
  /** Row menu — the mouse path to the `e` and `d` shortcuts. Absent when the
   *  viewer may not give that verdict on this item. */
  onAskChanges?: () => void;
  onDismiss?: () => void;
  onOpenSession?: () => void;
  /** A row a bar verb acts on. `selecting`: select mode is on, so a click
   *  toggles the row (shift: a range) instead of opening it. `disabled`: in
   *  select mode, a row no bar verb acts on. Null: the row shows no checkbox. */
  selection: {
    checked: boolean;
    selecting: boolean;
    disabled?: boolean;
    onToggle: (range: boolean) => void;
  } | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tBulk = useTranslations('hardcodedUi.reviewBulk');
  const kind = KIND_META[item.kind];
  const segment = segmentForStatus(item.status);
  const pending = segment === 'needs_you';
  const number = item.kind === 'change' ? item.detail.number : undefined;
  const diff = item.kind === 'change' ? item.detail.advanced : undefined;
  const glyph = STATUS_GLYPH[item.status];
  // Meta line: when · who · where. The session stands in for the repo; when
  // the group already names it, the row's own summary fills the slot.
  const where = sessionLabel ?? item.summary;
  // Nothing to review: the modal offers only Deny, so the row says so in
  // place of "awaiting approval". Nothing is denied automatically.
  const denyOnly = pending && reviewApprovalDenyOnly(item);
  const tReview = useTranslations('hardcodedUi.approvalPage');
  const selecting = selection?.selecting ?? false;
  const selectable = !!selection && !selection.disabled;

  // The leading icon names the kind by shape and the outcome by color:
  // blue while it needs you, then green/orange/red/muted once decided — the
  // same tone as the status check beside the title.
  const kindIcon = (
    <kind.icon
      className={cn(
        'size-5 shrink-0',
        glyph ? glyph.className : kind.iconColor,
        selectable && !selecting && 'group-focus-within:hidden group-hover:hidden',
      )}
      aria-label={reviewKindLabel(item.kind, tI18nComplete)}
    />
  );
  // One fixed 20 px slot: the kind icon, swapped for the checkbox on row
  // hover and for the whole of select mode. Nothing shifts.
  const leading = !selectable || !selection ? (
    kindIcon
  ) : (
    <span className="flex size-5 shrink-0 items-center justify-center">
      {selecting ? (
        <Checkbox
          checked={selection.checked}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none"
        />
      ) : (
        <>
          {kindIcon}
          <Checkbox
            checked={false}
            aria-label={tBulk('selectRow', { title: item.title })}
            onClick={(e) => {
              // The row's own state decides; Radix skips its toggle.
              e.preventDefault();
              selection.onToggle(e.shiftKey);
            }}
            className="hidden group-focus-within:flex group-hover:flex"
          />
        </>
      )}
    </span>
  );

  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
        {number != null && (
          <span className="text-muted-foreground shrink-0 text-sm tabular-nums">#{number}</span>
        )}
        {glyph && (
          <Hint label={reviewStatusLabel(item.status, tI18nComplete)}>
            <glyph.icon
              className={cn('size-3.5 shrink-0', glyph.className)}
              aria-label={reviewStatusLabel(item.status, tI18nComplete)}
            />
          </Hint>
        )}
        {fresh && (
          <Badge variant="new" size="sm" className="shrink-0">
            {tI18nComplete.raw('text18fdd549b2ed')}
          </Badge>
        )}
      </span>
      <span className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
        <TimeAgo iso={item.createdAt} />
        {item.kind === 'approval' && segment !== 'done' && item.expiresAt ? (
          <ExpiresIn iso={item.expiresAt} />
        ) : null}
        <Dot />
        <span className="truncate">{item.agent}</span>
        {denyOnly ? (
          <>
            <Dot />
            <span className="flex min-w-0 items-center gap-1">
              <WarningIcon aria-hidden className="text-kortix-orange size-3.5 shrink-0" />
              <span className="truncate">{tReview('canOnlyBeDenied')}</span>
            </span>
          </>
        ) : where ? (
          <>
            <Dot />
            <span className="truncate">{where}</span>
          </>
        ) : null}
      </span>
    </>
  );

  // The menu's Select hands focus to the row (select mode drops the menu), not
  // back to the trigger that is about to unmount.
  const enteringSelect = useRef(false);

  const diffStat = diff ? (
    <DiffStat
      additions={diff.additions}
      deletions={diff.deletions}
      className="hidden text-xs sm:inline-flex"
    />
  ) : null;

  // Select mode: the whole row is the option (trigger-list.tsx), with no
  // open button and no menu inside it to steal the click.
  if (selecting && selection) {
    return (
      <li
        data-idx={idx}
        role="option"
        aria-selected={selection.checked}
        aria-disabled={selection.disabled || undefined}
        tabIndex={selectable ? 0 : -1}
        onClick={selectable ? (e) => selection.onToggle(e.shiftKey) : undefined}
        onKeyDown={(e) => {
          if (selectable && (e.key === ' ' || e.key === 'Enter')) {
            e.preventDefault();
            selection.onToggle(e.shiftKey);
          }
        }}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-1.5 outline-none select-none',
          'focus-visible:ring-ring focus-visible:ring-2',
          focused || selection.checked ? 'bg-active' : selectable && 'hover:bg-hover',
          selectable && 'cursor-pointer',
        )}
      >
        {leading}
        <span className="min-w-0 flex-1">{body}</span>
        {diffStat ? <span className="flex shrink-0 items-center">{diffStat}</span> : null}
      </li>
    );
  }

  return (
    <li
      data-idx={idx}
      className={cn(
        'group relative flex items-center gap-3 rounded-md px-3 py-1.5',
        focused ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      {leading}

      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        {body}
      </button>

      <div className="flex shrink-0 items-center gap-2">
        {diffStat}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tI18nComplete('textcbd7bbfcd257', { value0: item.title })}
              className="text-muted-foreground"
            >
              <DotsThree className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-52"
            onCloseAutoFocus={(e) => {
              if (enteringSelect.current) e.preventDefault();
              enteringSelect.current = false;
            }}
          >
            <DropdownMenuItem onClick={onOpen}>
              {tI18nComplete.raw('texted077f3d8125')}
              <DropdownMenuShortcut>↵</DropdownMenuShortcut>
            </DropdownMenuItem>
            {onOpenSession && (
              <DropdownMenuItem onClick={onOpenSession}>
                {tI18nComplete.raw('textb205bb47f81a')}
              </DropdownMenuItem>
            )}
            {pending && (onAskChanges || onDismiss) && <DropdownMenuSeparator />}
            {pending && onAskChanges && (
              <DropdownMenuItem onClick={onAskChanges}>
                {tI18nComplete.raw('text705364916412')}
                <DropdownMenuShortcut>e</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {pending && onDismiss && (
              <DropdownMenuItem variant="destructive" onClick={onDismiss}>
                {tI18nComplete.raw('text48845bff334a')}
                <DropdownMenuShortcut>d</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {/* The touch and Tab path into select mode (Triggers parity). */}
            {selectable && selection ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    enteringSelect.current = true;
                    selection.onToggle(false);
                  }}
                >
                  <CheckSquareIcon />
                  {tI18nComplete.raw('text2a78025de6aa')}
                  <DropdownMenuShortcut>x</DropdownMenuShortcut>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/** One plain bar per row, row height, while the inbox loads. */
function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-1">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-md" />
      ))}
    </div>
  );
}

function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const localized = localizeUiCatalog(SHORTCUTS, tI18nComplete, PRODUCT_CATALOG_TRANSLATION_KEYS);
  // `x` after `d`. Its label is the shared "Select" message, which the
  // generated catalog map does not list.
  const shortcuts = [
    ...localized.slice(0, 5),
    { keys: ['x'], label: tI18nComplete.raw('text2a78025de6aa') },
    ...localized.slice(5),
  ];
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="lg:max-w-sm">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('texte9bef0b0f3c2')}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <ul className="space-y-2">
            {shortcuts.map((s) => (
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

/** How long the prototype's Undo toast stays up: a display time, not motion. */
const UNDO_TOAST_MS = 6000;

/** The prototype inbox's rule: every verdict, since nothing reaches a route. */
const EVERY_VERDICT = () => true;

/** The status a bar verb leaves an item in, for the optimistic update. */
const BULK_STATUS: Record<BulkVerb, ReviewStatus> = {
  approve: 'approved',
  deny: 'rejected',
  dismiss: 'dismissed',
};
const BULK_PROGRESS = { approve: 'approving', deny: 'denying', dismiss: 'dismissing' } as const;
const RISK_BADGE: Record<
  ReviewRisk,
  {
    variant: 'muted' | 'warning' | 'destructive';
    key: 'riskNone' | 'riskLow' | 'riskMedium' | 'riskHigh';
  }
> = {
  none: { variant: 'muted', key: 'riskNone' },
  low: { variant: 'muted', key: 'riskLow' },
  medium: { variant: 'warning', key: 'riskMedium' },
  high: { variant: 'destructive', key: 'riskHigh' },
};

export function ReviewCenter({
  initialItems,
  segment: segmentProp,
  onSegmentChange,
  loadMore,
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
  verdictAllowed = EVERY_VERDICT,
}: {
  /** When provided, the inbox renders real data instead of the mock fixtures. */
  initialItems?: ReviewItem[];
  /** Connected mode: the segment is the server's filter, so the parent owns it. */
  segment?: ReviewSegment;
  onSegmentChange?: (segment: ReviewSegment) => void;
  /** Connected mode: the segment has more pages than `initialItems` holds. */
  loadMore?: { onLoadMore: () => void; isLoading: boolean; isError: boolean };
  /** Connected mode: fire the server verdict for a single item. */
  onAct?: (id: string, verdict: ReviewVerdict, feedback?: string) => void;
  /** Connected mode: fire the server verdict for many items (the select-mode
   *  bar and `d`). Resolves with one result per id; absent results mean all ok. */
  onBulkAct?: (
    ids: string[],
    verdict: ReviewVerdict,
  ) => void | Promise<readonly BulkResult[] | undefined>;
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
  /** Connected mode: whether this viewer may give `verdict` on `item`
   *  (`reviewVerdictAllowed`, KRTX-1720). A control or shortcut for a verdict
   *  it refuses does nothing and does not render. Absent: every verdict. */
  verdictAllowed?: (item: ReviewItem, verdict: ReviewVerdict) => boolean;
} = {}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tBulk = useTranslations('hardcodedUi.reviewBulk');
  const tSidebar = useTranslations('sidebar');
  const segments = useMemo(
    () => localizeUiCatalog(SEGMENTS, tI18nComplete, PRODUCT_CATALOG_TRANSLATION_KEYS),
    [tI18nComplete],
  );
  const kindFilters = useMemo(
    () => localizeUiCatalog(KIND_FILTERS, tI18nComplete, PRODUCT_CATALOG_TRANSLATION_KEYS),
    [tI18nComplete],
  );
  const localizedMockItems = useMemo(() => getLocalizedMockItems(tI18nComplete), [tI18nComplete]);
  const connected = !!onAct;
  const [items, setItems] = useState<ReviewItem[]>(
    initialItems ?? (connected ? [] : localizedMockItems),
  );
  const [localSegment, setLocalSegment] = useState<ReviewSegment>('needs_you');
  const segment = segmentProp ?? localSegment;
  const setSegment = onSegmentChange ?? setLocalSegment;
  const [kindFilter, setKindFilter] = useState<ReviewKind | 'all'>('all');
  const [query, setQuery] = useState('');
  // Per-session view: filter to one session, and/or group the list by session so
  // a session's reviews + approvals sit together. Both operate on `sessionId`.
  const [sessionFilter, setSessionFilter] = useState<string | 'all'>('all');
  const [grouped, setGrouped] = useState(false);
  // The open review lives in the URL (`?id=<review item id>`), not in state,
  // so a refresh or a shared link lands on the same page.
  const search = useUiSearchParams();
  const router = useUiRouter();
  const pathname = useUiPathname();
  const idParam = search?.get('id') ?? null;
  const [focusedIdx, setFocusedIdx] = useState(0);
  // Only show the focused-row highlight while the user is actually navigating by
  // keyboard — otherwise the first row looks arbitrarily tinted on load.
  const [kbNav, setKbNav] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // "Fresh" = items that arrived on a poll while the user wasn't looking. We diff
  // incoming ids against the last-known set of each segment (each segment is
  // its own read); any interaction clears the marks.
  const knownIdsRef = useRef(new Map<ReviewSegment, Set<string>>());
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
  /* ── Select mode: pick up to 50 rows, then Approve / Deny / Dismiss ── */
  // 'key' when `x` opened it: the bar then skips its enter animation.
  const [selectMode, setSelectMode] = useState<false | 'pointer' | 'key'>(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{
    label: string;
    done: number;
    total: number;
  } | null>(null);
  // The verb outlives `open` so the dialog keeps its copy while it closes.
  const [confirm, setConfirm] = useState<{ verb: BulkVerb; open: boolean }>({
    verb: 'approve',
    open: false,
  });
  // Only Needs you holds rows a bar verb acts on.
  const selectableIds = useMemo(
    () =>
      segment === 'needs_you'
        ? visible.filter((i) => bulkSelectable(i, verdictAllowed)).map((i) => i.id)
        : [],
    [visible, segment, verdictAllowed],
  );
  // Rows that left the list (decided, filtered) drop out of the selection.
  const selectedItems = useMemo(
    () => visible.filter((i) => selectedIds.has(i.id)),
    [visible, selectedIds],
  );
  const bulkIds = useMemo(() => {
    const idsFor = (verb: BulkVerb) =>
      selectedItems.filter((i) => bulkSupports(i, verb, verdictAllowed)).map((i) => i.id);
    return { approve: idsFor('approve'), deny: idsFor('deny'), dismiss: idsFor('dismiss') };
  }, [selectedItems, verdictAllowed]);
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setAnchorId(null);
  };
  const toggleSelected = (id: string, range: boolean, via: 'pointer' | 'key') => {
    let next = range
      ? selectRange(selectedIds, selectableIds, anchorId, id)
      : toggleId(selectedIds, id);
    if (next.size > BULK_MAX) {
      // A 51st single toggle changes nothing, the anchor included; a range
      // keeps its first 50.
      if (!range) return;
      next = new Set([...next].slice(0, BULK_MAX));
    }
    setSelectedIds(next);
    setAnchorId(id);
    // The toggled row takes the cursor, so select mode focuses it.
    setFocusedIdx(visibleIndexById.get(id) ?? 0);
    setSelectMode((mode) => mode || via);
  };
  // A segment, kind, session or search change drops the selection: a bulk
  // verb never reaches a hidden row. Leaving Needs you leaves select mode.
  const selectionScope = `${segment}\u0000${kindFilter}\u0000${sessionFilter}\u0000${query}`;
  const [selectionScopeSeen, setSelectionScopeSeen] = useState(selectionScope);
  if (selectionScope !== selectionScopeSeen) {
    setSelectionScopeSeen(selectionScope);
    setSelectedIds(new Set());
    setAnchorId(null);
    if (segment !== 'needs_you') setSelectMode(false);
  }

  // If the active session filter no longer has items in this segment, reset it.
  if (sessionFilter !== 'all' && !sessionOpts.some((s) => s.sessionId === sessionFilter)) {
    setSessionFilter('all');
  }

  // Keep the focus cursor in range as the visible list changes.
  const [visibleCountSeen, setVisibleCountSeen] = useState<number | null>(null);
  if (visible.length !== visibleCountSeen) {
    setVisibleCountSeen(visible.length);
    setFocusedIdx((i) => Math.max(0, Math.min(i, visible.length - 1)));
  }

  // Select mode: DOM focus follows the cursor (j/k, a toggled row), so Space
  // and Enter act on the row the user sees, and a pointer entry that
  // unmounts the clicked checkbox keeps focus on its row.
  useEffect(() => {
    if (!selectMode) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${focusedIdx}"]`)
      ?.focus({ preventScroll: true });
  }, [selectMode, focusedIdx]);

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
  const [initialItemsSeen, setInitialItemsSeen] = useState(initialItems);
  if (initialItems !== initialItemsSeen) {
    setInitialItemsSeen(initialItems);
    if (initialItems) setItems(initialItems);
    setPendingId(null);
    setPendingDecision(null);
  }

  // Detect items that arrived since the user last looked → flag them "fresh".
  // The first load of each segment seeds its known set silently (nothing is
  // "new" on open, or on a first visit to a segment).
  // Reads the server list, not the optimistic copy: the copy lags a segment
  // switch by one commit and would seed the new segment with nothing.
  useEffect(() => {
    if (!connected || isLoading || !initialItems) return;
    const ids = initialItems
      .filter((i) => segmentForStatus(i.status) === segment)
      .map((i) => i.id);
    const known = knownIdsRef.current.get(segment);
    knownIdsRef.current.set(segment, new Set(ids));
    if (!known) return;
    const arrived = ids.filter((id) => !known.has(id));
    if (arrived.length > 0) {
      setFreshIds((prev) => {
        const n = new Set(prev);
        for (const id of arrived) n.add(id);
        return n;
      });
    }
  }, [initialItems, connected, segment, isLoading]);

  /** Prototype mode: optimistic change with an Undo affordance in the toast. */
  function commit(next: ReviewItem[], message: string, tone: 'success' | 'info' = 'success') {
    undoRef.current = items;
    setItems(next);
    undoToast(message, {
      duration: UNDO_TOAST_MS,
      icon: tone === 'info' ? toastIcon('info') : toastIcon('success'),
      undoLabel: tI18nComplete.raw('texta8283ade3185'),
      onUndo: () => {
        if (undoRef.current) {
          setItems(undoRef.current);
          undoRef.current = null;
          infoToast(tI18nComplete.raw('text5d561a1e3f17'));
        }
      },
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

  /** Every verdict path checks here first, so a refused verdict never commits. */
  const allowsId = (id: string, verdict: ReviewVerdict) => {
    const item = items.find((i) => i.id === id) ?? sourceItems.find((i) => i.id === id);
    return !!item && verdictAllowed(item, verdict);
  };

  const actions: ReviewActions = {
    resolve: (id, status, message, feedback) => {
      const verdict = statusToVerdict(status);
      if (verdict && !allowsId(id, verdict)) return;
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
    allows: verdictAllowed,
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
    if (!verdictAllowed(item, 'approve')) return;
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
      if (!verdictAllowed(item, 'changes')) return;
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

  const dismissIds = (requested: string[]) => {
    const ids = requested.filter((id) => allowsId(id, 'dismiss'));
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
          () =>
            void Promise.resolve(onBulkAct(outcome.act, 'dismiss')).catch((e: Error) =>
              errorToast(e.message),
            ),
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

  /** The bar's verb on every selected row that supports it. One request; the
   *  results drive the optimistic update (ok ids only) and the toast. */
  const runBulk = async (verb: BulkVerb) => {
    setConfirm((c) => ({ ...c, open: false }));
    const ids = bulkIds[verb];
    if (ids.length === 0) return;
    setBulkProgress({
      label: tBulk(BULK_PROGRESS[verb], { count: ids.length }),
      done: 0,
      total: ids.length,
    });
    let results: readonly BulkResult[];
    try {
      results =
        (await onBulkAct?.(ids, BULK_VERDICT[verb])) ?? ids.map((id) => ({ id, ok: true }));
    } catch (e) {
      setBulkProgress(null);
      errorToast(e instanceof Error ? e.message : String(e));
      return;
    }
    setBulkProgress(null);
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
    setItems((prev) => bulkSetStatus(prev, okIds, BULK_STATUS[verb]));
    setSelectedIds((prev) => new Set([...prev].filter((id) => !okIds.has(id))));
    const message = bulkResultMessage(tBulk, verb, results);
    if (okIds.size === results.length) successToast(message);
    else if (okIds.size > 0) infoToast(message);
    else errorToast(message);
  };
  // Every bulk verb confirms first, listing what it will decide.
  const startBulk = (verb: BulkVerb) => setConfirm({ verb, open: true });

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
        // An Esc that a dialog or menu already handled is theirs, not the selection's.
        if (selectMode && !bulkProgress && !e.defaultPrevented && !hasOpenFloatingLayer()) {
          exitSelectMode();
        }
        return;
      }
      // Help, a review page or the bulk confirm owns the keyboard.
      if (helpOpen || selectedId || confirm.open) return;
      if (typing) return; // don't hijack search typing

      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('review-search')?.focus();
        return;
      }
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        setSegment(segments[Number(e.key) - 1].value);
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
      } else if (e.key === 'x') {
        if (cur && selectableIds.includes(cur.id)) toggleSelected(cur.id, false, 'key');
      } else if (selectMode) {
        // Select mode: a row's Space or Enter toggles it; no verb shortcut fires.
        return;
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
      sessionLabel={!inGroup && item.sessionId ? labelFor(item.sessionId) : undefined}
      onOpen={() => setSelectedId(item.id)}
      onAskChanges={verdictAllowed(item, 'changes') ? () => quickAskChanges(item) : undefined}
      onDismiss={verdictAllowed(item, 'dismiss') ? () => dismissIds([item.id]) : undefined}
      onOpenSession={
        item.sessionId && onOpenSession ? () => onOpenSession(item.sessionId!) : undefined
      }
      selection={
        selectMode || selectableIds.includes(item.id)
          ? {
              checked: selectedIds.has(item.id),
              selecting: !!selectMode,
              disabled: !selectableIds.includes(item.id),
              onToggle: (range) => toggleSelected(item.id, range, 'pointer'),
            }
          : null
      }
    />
  );

  // Select mode makes each row list a multi-select listbox (trigger-list.tsx).
  const listboxProps = {
    role: selectMode ? 'listbox' : undefined,
    'aria-multiselectable': selectMode ? true : undefined,
  };
  const listProps = {
    ref: (el: HTMLElement | null) => {
      listRef.current = el;
    },
    onPointerMove: () => {
      setKbNav((k) => (k ? false : k));
      markSeen();
    },
  };

  // The Sessions page's Load more, same control and words (`sidebar.*`).
  const loadMoreButton = loadMore ? (
    <div className="flex justify-center pb-2">
      <Button
        variant="outline"
        size="sm"
        disabled={loadMore.isLoading}
        onClick={loadMore.onLoadMore}
      >
        {/* A failed page keeps the rows above it; the button is the retry. */}
        {loadMore.isLoading
          ? tSidebar('loadingMore')
          : loadMore.isError
            ? tSidebar('retry')
            : tSidebar('loadMore')}
      </Button>
    </div>
  ) : null;

  const shortcutsButton = (
    <button
      type="button"
      onClick={() => setHelpOpen(true)}
      className="text-muted-foreground hover:text-foreground duration-fast hidden items-center gap-1.5 text-xs transition-colors sm:flex"
    >
      <Kbd>?</Kbd>
      {tI18nComplete.raw('text46e978d0c193')}
    </button>
  );

  const bulkActions: SelectionBarAction[] = [
    {
      id: 'approve',
      label: tBulk('approve'),
      disabled: bulkIds.approve.length === 0,
      onSelect: () => startBulk('approve'),
    },
    {
      id: 'deny',
      label: tBulk('deny'),
      tone: 'destructive',
      disabled: bulkIds.deny.length === 0,
      onSelect: () => startBulk('deny'),
    },
    {
      id: 'dismiss',
      label: tBulk('dismiss'),
      tone: 'destructive',
      disabled: bulkIds.dismiss.length === 0,
      onSelect: () => startBulk('dismiss'),
    },
  ];

  const confirmCount = bulkIds[confirm.verb].length;
  const confirmIds = new Set(bulkIds[confirm.verb]);
  // Every item the verb will decide: which app, what it does, to what, how risky.
  const confirmList = (
    <ul className="border-border divide-border max-h-72 w-full min-w-0 divide-y overflow-y-auto rounded-lg border">
      {selectedItems
        .filter((i) => confirmIds.has(i.id))
        .map((i) => {
          const risk = RISK_BADGE[i.risk];
          // The arguments, as the approval modal reads them: the content
          // Kortix resolved, else the call's own preview.
          const details = reviewApprovalDetails(i);
          const args = reviewArgsSummary(details?.resolved_preview, details?.args_preview);
          const who = details ? approvalIdentity(details) : null;
          return (
            <li key={i.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5" title={details?.action}>
              {/* md tile (32px) spans the two text lines beside it. */}
              {who ? <ConnectorAppMark name={who.connector ?? i.title} iconUrl={who.iconUrl} size="md" /> : null}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground truncate text-sm leading-5">
                  {who?.connector && who.action ? `${who.connector} · ${who.action}` : i.title}
                </span>
                {args ? <span className="text-muted-foreground truncate text-xs leading-4">{args}</span> : null}
              </span>
              <Badge variant={risk.variant} size="xs" className="shrink-0">
                {tBulk(risk.key)}
              </Badge>
            </li>
          );
        })}
    </ul>
  );
  const withList = (text: string) => (
    <div className="space-y-3">
      <p>{text}</p>
      {confirmList}
    </div>
  );
  const confirmCopy =
    confirm.verb === 'approve'
      ? {
          title: tBulk('approveTitle', { count: confirmCount }),
          confirm: tBulk('approveConfirm', { count: confirmCount }),
          description: withList(tBulk('approveDescription')),
        }
      : confirm.verb === 'deny'
        ? {
            title: tBulk('denyTitle', { count: confirmCount }),
            confirm: tBulk('denyConfirm', { count: confirmCount }),
            description: withList(tBulk('denyDescription')),
          }
        : {
            title: tBulk('dismissTitle', { count: confirmCount }),
            confirm: tBulk('dismissConfirm', { count: confirmCount }),
            description: withList(tBulk('dismissDescription')),
          };

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

  // A Connector call opens the standalone approve page's panel in a modal over
  // the inbox, so it reads and decides the same way on both surfaces.
  const approval = selected ? reviewApprovalDetails(selected) : null;
  const approvalCall =
    approval && selected?.kind === 'approval' ? selected.detail.actions?.[0] : undefined;
  const approvalModal = (
    <ApprovalDecisionModal
      details={approval}
      previewAuthorized={approvalCall?.previewAuthorized !== false}
      resolvers={approvalCall?.resolvers}
      {...(approval && selected ? reviewApprovalAsker(selected, sessionLabels) : null)}
      busyDecision={selected && pendingId === selected.id ? pendingDecision : null}
      onDecision={
        // Only the viewer the API lets decide this call gets the decision.
        connected && selected && verdictAllowed(selected, 'approve')
          ? (decision, note) =>
              actions.resolve(
                selected.id,
                decision === 'approve' ? 'approved' : 'rejected',
                decision === 'approve'
                  ? tI18nComplete.raw('text0674d4a026cb')
                  : tI18nComplete.raw('text4341be8eb7f0'),
                note,
              )
          : undefined
      }
      onOpenSession={
        selected?.sessionId && onOpenSession
          ? () => onOpenSession(selected.sessionId!)
          : undefined
      }
      onClose={() => setSelectedId(null)}
    />
  );

  // Every other review page replaces the inbox in place — same scroll
  // container, no modal. Escape and "Back to inbox" return to the list.
  if (selected && !approval) {
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
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The select bar covers the list's last row: pad for it. */}
        <div className={cn('w-full px-4', selectMode && segment === 'needs_you' && 'pb-20')}>
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
                {segments.map((s) => (
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
                      ? tI18nComplete.raw('textf10988e79e8d')
                      : kindFilters.find((f) => f.value === kindFilter)?.label}
                    <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>{tI18nComplete.raw('textbaaddf70fb5d')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={kindFilter}
                    onValueChange={(v) => setKindFilter(v as ReviewKind | 'all')}
                  >
                    {kindFilters.map((f) => (
                      <DropdownMenuRadioItem key={f.value} value={f.value} side="left">
                        {f.label}
                        {(kindCounts[f.value] ?? 0) > 0 && (
                          <CountBadge count={kindCounts[f.value] ?? 0} className="ml-auto" />
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
                          ? tI18nComplete.raw('text78648d4d6649')
                          : (sessionOpts.find((s) => s.sessionId === sessionFilter)?.label ??
                            'Session')}
                      </span>
                      <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
                    <DropdownMenuLabel>{tI18nComplete.raw('text6959b4159575')}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={sessionFilter} onValueChange={setSessionFilter}>
                      <DropdownMenuRadioItem value="all" side="left">
                        {tI18nComplete.raw('text78648d4d6649')}
                        <CountBadge
                          count={filterItems(items, segment, kindFilter, query, 'all').length}
                          className="ml-auto"
                        />
                      </DropdownMenuRadioItem>
                      {sessionOpts.map((s) => (
                        <DropdownMenuRadioItem key={s.sessionId} value={s.sessionId} side="left">
                          <span className="truncate">{s.label}</span>
                          <CountBadge
                            count={filterItems(items, segment, kindFilter, query, s.sessionId).length}
                            className="ml-auto"
                          />
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
                      {tI18nComplete.raw('text137f98df3b9b')}
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
                  placeholder={tI18nComplete.raw('text49c266baaaa7')}
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
              title={tI18nComplete.raw('text23686ff6ba91')}
              description={tI18nComplete.raw('text481859b689b0')}
              action={
                <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
                  {isFetching ? <Loading className="size-3.5 shrink-0" /> : null}
                  {tI18nComplete.raw('text942087cc2d41')}
                </Button>
              }
            />
          ) : isLoading && items.length === 0 ? (
            <ListSkeleton />
          ) : visible.length === 0 && loadMore ? (
            // Nothing on the pages read so far matches, and more pages exist:
            // offer them, never the empty state (KRTX-1727).
            <div className="pt-6">{loadMoreButton}</div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={CheckCircleSolid}
              size="sm"
              title={
                query
                  ? tI18nComplete.raw('text2df01a03ff43')
                  : segment === 'needs_you'
                    ? tI18nComplete.raw('text2f485b9971df')
                    : tI18nComplete.raw('textf4c7f41c12d6')
              }
              description={
                query
                  ? tI18nComplete.raw('text2e6d79de50dc')
                  : segment === 'needs_you'
                    ? tI18nComplete.raw('text67735374cc20')
                    : segment === 'waiting'
                      ? tI18nComplete.raw('text2c192433a710')
                      : tI18nComplete.raw('text6a00736dae3c')
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
                        {tI18nComplete.raw('textb205bb47f81a')}
                      </button>
                    )}
                  </div>
                  <ul {...listboxProps} className={LIST_CLASS}>
                    {g.items.map((item) =>
                      renderRow(item, visibleIndexById.get(item.id) ?? 0, true),
                    )}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <ul {...listProps} {...listboxProps} className={LIST_CLASS}>
              {visible.map((item, idx) => renderRow(item, idx, false))}
            </ul>
          )}
          {visible.length > 0 && loadMore ? loadMoreButton : null}

        </div>
      </div>
      {selectMode && segment === 'needs_you' ? (
        // Pinned to the bottom of the list column, not to the end of the list:
        // `sticky` stops where a short list ends (schedule-view.tsx).
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
          <div className="pointer-events-auto w-full max-w-xl">
            <SelectionBar
              selectedCount={selectedItems.length}
              allSelected={
                selectableIds.length > 0 &&
                selectedItems.length >= Math.min(BULK_MAX, selectableIds.length)
              }
              canSelectAll={selectableIds.length > 0}
              onSelectAll={() => setSelectedIds(new Set(selectableIds.slice(0, BULK_MAX)))}
              onClear={() => setSelectedIds(new Set())}
              onExit={exitSelectMode}
              actions={bulkActions}
              progress={bulkProgress}
              animateIn={selectMode !== 'key'}
              note={
                selectedItems.length >= BULK_MAX && selectableIds.length > BULK_MAX
                  ? tBulk('limitNote', { count: BULK_MAX })
                  : undefined
              }
            />
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm.open}
        onOpenChange={(open) => setConfirm((c) => ({ ...c, open }))}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.confirm}
        confirmVariant={confirm.verb === 'approve' ? 'default' : 'destructive'}
        onConfirm={() => void runBulk(confirm.verb)}
      />

      {approvalModal}
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
