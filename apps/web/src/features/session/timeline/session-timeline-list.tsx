'use client';

/**
 * The transcript as a list of rows.
 *
 * `SessionChat` builds the rows (`buildChatRows`) and hands them here with the
 * host facts it still derives (`turnsById`, `turnRenderKeys`, `pendingTurnIds`,
 * …). This file renders them: `groupRowsByTurn` cuts the flat rows per turn,
 * and every turn is a `TurnFrame` — the SAME `TurnViewport` wrapper as before
 * (`[data-turn-id]` root) around memo'd row components.
 *
 * TWO RENDER PATHS, ONE TURN MARKUP.
 * - FLAT (no `scrollElement`: a static render, SSR, a host without one, or
 *   `virtualize={false}`): every turn, in a fragment, `mt-3` / `mt-12` gap as
 *   the turn's class — byte-for-byte the Stage 2 output the goldens pin.
 * - VIRTUAL (`scrollElement` set): `VirtualTurnList` — `useVirtualizer` with
 *   ONE ITEM PER TURN; only the turns in and near the viewport (plus the pinned
 *   tail) are in the DOM, absolutely positioned inside one box sized to the
 *   measured total. The turn's own markup is identical; the gap moves from the
 *   turn's top margin to the previous item's bottom padding so an item's
 *   `start` is its turn element's top. Rules and the host API live in
 *   `timeline-virtual.ts`.
 *
 * THE ONE RULE THAT KEEPS THE SCROLL PHYSICS: `[data-turn-pending]` and
 * `[data-turn-queue-state]` are emitted on the bubble wrapper INSIDE the
 * `[data-turn-id]` element. `use-auto-scroll.ts` anchors on the last turn
 * element without a pending descendant, `session-history-scroll.ts` and
 * `chat-minimap.tsx` query `[data-turn-id]`, and the scroll-to-turn lookup in
 * `session-chat.tsx` does too. Flattening `TurnFrame` away, or moving the
 * bubble's attributes onto the turn element, breaks all four. Asserted by
 * `session-timeline-list.golden.test.tsx` (nesting regex) and
 * `turn-viewport.test.tsx`.
 *
 * WHO RE-RENDERS ON A DELTA. `AssistantPartRow` / `UserMessageRow` /
 * `TurnTailRow` are `memo`'d on props that are reference-stable for an
 * unchanged row (`projectTurnPlacements`, `stabilizeTurns`, `useCallback`
 * handlers). `TurnFrame` is `memo`'d too (`turn-frame-memo.ts`): its `group`
 * is identity-stable for an untouched turn (`groupRowsByTurn` with the list's
 * `TurnGroupCache` hands the previous group object back when the turn's rows
 * did not change), its `turn` is (`stabilizeTurns`), and the list-wide facts
 * it reads are compared per turn — so one appended part runs ONE frame body,
 * the working turn's. `TurnFrame` owns the per-turn hooks (the 2.5s status
 * throttle, the 1s elapsed and retry tickers, `copied`, the dialog state) and
 * exposes them through `TurnFrameContext`, which ONLY `TurnTailRow` consumes —
 * so a tick re-renders the tail and nothing else. The render-counter test
 * (`session-timeline-list.render-count.test.tsx`) holds this on the flat path,
 * `session-timeline-list.virtual.test.tsx` on the virtual one.
 */
import { Button } from '@/components/ui/button';
import { Copy } from '@/features/icon/icons/copy';
import { ConnectProviderDialog } from '@/features/session/model-selector';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { showTurnBusyIndicator } from '@/features/session/turn-busy-visibility';
import { useModelPricingLookup } from '@/lib/model-pricing';
import { cn } from '@/lib/utils';
import type { KortixSystemMessage, SessionReport } from '@/lib/utils/kortix-system-tags';
import { type ConversationDensity, useUserPreferencesStore } from '@/stores/user-preferences-store';
import {
  type Command,
  type MessageWithParts,
  type PermissionRequest,
  type QuestionRequest,
  type SessionStatus,
  type TextPart,
  type ToolPart,
  type Turn,
  type TurnCostInfo,
  formatDuration,
  getRetryInfo,
  getRetryMessage,
  getTurnStatus,
  shouldShowToolPart,
} from '@/ui';
import type { SessionPrompt, TimelineRow, TimelineUserMessageRow } from '@kortix/sdk';
import type { ProviderListResponse } from '@kortix/sdk/react';
import { CheckIcon, StackIcon as Layers } from '@phosphor-icons/react';
import {
  type VirtualItem,
  type Virtualizer,
  elementScroll,
  measureElement as measureElementDefault,
  useVirtualizer,
} from '@tanstack/react-virtual';
import { AnimatePresence, m } from 'motion/react';
import { useTranslations } from 'next-intl';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { TURN_TOP_OFFSET } from '@/hooks/use-auto-scroll';

import { CodeBlockEndpoints, SandboxUrlDetector } from '../sandbox-url-detector';
import { SessionBusyIndicator } from '../session-busy-indicator';
import { SessionTurnMeta } from '../session-turn-meta';
import { ActivityBurst } from '../turn/activity-burst';
import { ExpandableOutput } from '../turn/expandable-output';
import {
  QUEUED_BUBBLE_OPACITY_CLASS,
  QueuedPromptActions,
  type QueuedPromptState,
  QueuedPromptStatus,
} from '../turn/queued-prompt-bubbles';
import { samePartsList } from '../turn/same-parts';
import { ThrottledMarkdown } from '../turn/throttled-markdown';
import { TurnViewport } from '../turn/turn-viewport';
import { UserMessage } from '../turn/user-message';
import {
  type TurnRowGroup,
  aliasRowKey,
  createTurnGroupCache,
  groupRowsByTurn,
} from './build-chat-rows';
import {
  type AssistantPartRowProps,
  type CommandInfo,
  type TurnView,
  createProjectionCache,
  deriveTurnView,
  projectTurnPlacements,
} from './project-rows';
import { timelineRowSlot } from './timeline-row-switch';
import {
  RENDER_OVERSCAN_COLD,
  RENDER_OVERSCAN_WARM,
  TURN_FALLBACK_SIZE,
  type TimelineVirtualApi,
  type TimelineVirtualSeam,
  VIRTUAL_OVERSCAN,
  isFollowing,
  pinnedTurnIndexes,
  recallTimelineMeasurements,
  rememberTimelineMeasurements,
  shouldAdjustForResize,
  timelineRangeIndexes,
  turnGapBelowClass,
} from './timeline-virtual';
import {
  AnsweredQuestionCard,
  CompactionDivider,
  SessionReportCard,
  SystemMessageIndicator,
} from './turn-cards';
import { sameTurnFrameProps } from './turn-frame-memo';
import { turnGapClass } from './turn-gap';

/** After this long on one status the working label shows elapsed time. */
const STATUS_STALL_AFTER_MS = 20_000;

// ============================================================================
// Props
// ============================================================================

export interface SessionTimelineListProps {
  /** `buildChatRows(...)` over the spliced messages. */
  rows: TimelineRow[];
  /** `stabilizeTurns` output, by `userMessage.info.id`. */
  turnsById: ReadonlyMap<string, Turn>;
  /** The React key per turn — the optimistic origin the bubble was FIRST
   *  painted under. See `SessionChat.turnRenderKeys`. */
  turnRenderKeys: ReadonlyMap<string, string>;
  /** User bubbles the agent has not reached yet (`resolveWorkingTurn`). */
  pendingTurnIds: ReadonlySet<string>;
  /** User bubbles a Stop stranded (`SessionChat.interruptedTurnIds`). */
  interruptedTurnIds: ReadonlySet<string>;
  /** `resolveLastTurnWorking` — the session's ONE working answer. */
  sessionWorking: boolean;
  /** `resolveWorkingTurn(...).workingTurnId` — the turn the agent is on. */
  workingTurnId: string | null;
  planAnchorId: string | null;
  inboxRowsByMessageId: ReadonlyMap<string, SessionPrompt>;
  queueHeld: boolean;
  onQueueRemove: (promptId: string) => void;
  onQueueSendNow: (promptId: string) => void;
  onQueueRetry: (promptId: string) => void;
  sessionId: string;
  sessionStatus: SessionStatus | undefined;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  agentNames?: string[];
  providers?: ProviderListResponse;
  commandMessages?: ReadonlyMap<string, CommandInfo>;
  commands?: Command[];
  disableToolNavigation?: boolean;
  onPermissionReply: (requestId: string, reply: 'once' | 'always' | 'reject') => Promise<void>;
  onRewind: (messageId: string, text: string) => void;
  rewindDisabled: boolean;
  /** Test seam: called with a row key on every render of a row component. */
  onRowRender?: (key: string) => void;
  /**
   * The transcript's scroll container, as STATE (the virtualizer subscribes to
   * it). `null` / absent renders the FLAT list: a static render, SSR, a host
   * with no scroll container. `SessionChat` mounts the list only once it has
   * the element, so the first paint is already the virtual window.
   */
  scrollElement?: HTMLDivElement | null;
  /** `false` forces the flat list even with a scroll element (kill switch, tests). */
  virtualize?: boolean;
  /** Open at the end (default) or at the top (a sub-session viewed from its start). */
  initialAtEnd?: boolean;
  /** Written with the virtual list's API while it is mounted, `null` otherwise. */
  apiRef?: React.RefObject<TimelineVirtualApi | null>;
  /** Tests and the bench only — see `TimelineVirtualSeam`. */
  virtualizerTestSeam?: TimelineVirtualSeam;
}

// ============================================================================
// Gap
// ============================================================================

// The vertical space before a turn lives in `./turn-gap` (pure); re-exported
// here because it is the list's rule and its tests import it from this module.
export { turnGapClass } from './turn-gap';

// ============================================================================
// SessionTimelineList
// ============================================================================

export function SessionTimelineList(props: SessionTimelineListProps) {
  const {
    rows,
    turnsById,
    turnRenderKeys,
    pendingTurnIds,
    sessionWorking,
    scrollElement = null,
    virtualize = true,
  } = props;
  // Group identity across frames, for the life of this list (see
  // `groupRowsByTurn`): the `TurnFrame` memo keys on it.
  const [groupCache] = useState(createTurnGroupCache);
  const groups = groupRowsByTurn(rows, groupCache);
  const pricingLookup = useModelPricingLookup(props.providers);
  // `?? 'normal'` — legacy persisted preferences predate this key (same rule
  // as every `panelMode` read site).
  const conversationDensity = useUserPreferencesStore(
    (s) => s.preferences.conversationDensity ?? 'normal',
  );

  // The virtual path needs a scroll container and a DOM (`getVirtualItems()`
  // is empty under `renderToStaticMarkup`: no rect, no range). Without either,
  // the flat list — exactly Stage 2's output.
  if (virtualize && scrollElement && typeof window !== 'undefined') {
    return (
      <VirtualTurnList
        list={props}
        groups={groups}
        scrollElement={scrollElement}
        pricingLookup={pricingLookup}
        density={conversationDensity}
      />
    );
  }

  return (
    <>
      {groups.map((group, index) => {
        const turn = turnsById.get(group.userMessageID);
        if (!turn) return null;
        return (
          <TurnFrame
            // ONE element per prompt: keyed by the id the bubble was FIRST
            // painted under, so the swap to a re-minted echo id re-renders
            // this node instead of mounting a new one (opacity keeps
            // animating, hover state survives, nothing jumps).
            key={turnRenderKeys.get(group.userMessageID) ?? group.userMessageID}
            group={group}
            turn={turn}
            className={turnGapClass({
              index,
              userMessageID: group.userMessageID,
              previousUserMessageID: groups[index - 1]?.userMessageID,
              lastTurnWorking: sessionWorking,
              pendingTurnIds,
            })}
            pricingLookup={pricingLookup}
            density={conversationDensity}
            list={props}
          />
        );
      })}
    </>
  );
}

// ============================================================================
// VirtualTurnList — the transcript as a virtual window of turns
// ============================================================================

type TurnVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

function VirtualTurnList({
  list,
  groups,
  scrollElement,
  pricingLookup,
  density,
}: {
  list: SessionTimelineListProps;
  groups: TurnRowGroup[];
  scrollElement: HTMLDivElement;
  pricingLookup: ReturnType<typeof useModelPricingLookup>;
  density: ConversationDensity;
}) {
  const {
    turnsById,
    turnRenderKeys,
    pendingTurnIds,
    interruptedTurnIds,
    sessionWorking,
    workingTurnId,
    sessionId,
    initialAtEnd = true,
    apiRef,
    virtualizerTestSeam,
  } = list;

  const boxRef = useRef<HTMLDivElement>(null);
  // Where the box sits in the scroll container's content space: the padding,
  // the older-history sentinel and the optimistic turn all sit above it and
  // come and go. Measured after every commit; a change re-renders once.
  const [scrollMargin, setScrollMargin] = useState(0);
  const [renderOverscan, setRenderOverscan] = useState(RENDER_OVERSCAN_COLD);

  const indexById = useMemo(
    () => new Map(groups.map((group, index) => [group.userMessageID, index] as const)),
    [groups],
  );
  // The item key is the turn's React key (`turnRenderKeys`: the optimistic
  // origin a bubble was first painted under), so measured sizes survive the
  // swap to a re-minted echo id. `removed:` guards a ResizeObserver entry for
  // a node whose turn already left the list (upstream L430-437).
  const getItemKey = useCallback(
    (index: number) => {
      const group = groups[index];
      if (!group) return `removed:${index}`;
      return turnRenderKeys.get(group.userMessageID) ?? group.userMessageID;
    },
    [groups, turnRenderKeys],
  );
  const pinned = useMemo(
    () =>
      pinnedTurnIndexes({
        count: groups.length,
        indexById,
        workingTurnId,
        pendingTurnIds,
        interruptedTurnIds,
      }),
    [groups.length, indexById, workingTurnId, pendingTurnIds, interruptedTurnIds],
  );
  // Indexes visible at the moment one turn grew by more than a viewport, kept
  // mounted for two frames so the correction lands on a rendered list
  // (upstream L468-490).
  const resizePinnedRef = useRef<number[]>([]);
  const resizePinFrameRef = useRef<number | undefined>(undefined);
  const scrollElementRef = useRef(scrollElement);
  scrollElementRef.current = scrollElement;
  const [initialMeasurements] = useState(() => recallTimelineMeasurements(sessionId));

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: groups.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => TURN_FALLBACK_SIZE,
    getItemKey,
    overscan: VIRTUAL_OVERSCAN,
    scrollMargin,
    // `scrollToIndex(align: 'start')` lands the turn TURN_TOP_OFFSET under the
    // viewport top — the legacy `offset − 24` of the jump and the minimap.
    scrollPaddingStart: TURN_TOP_OFFSET,
    initialOffset: () => (initialAtEnd ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    // Prepend / remove anchoring ONLY — see timeline-virtual.ts, "WHO OWNS THE
    // END": `scrollEndThreshold: -1` makes virtual-core's "at end" checks
    // false, so it never follows; `use-auto-scroll` does.
    anchorTo: 'end',
    followOnAppend: false,
    scrollEndThreshold: -1,
    rangeExtractor: (range) =>
      timelineRangeIndexes(range, renderOverscan, [...pinned, ...resizePinnedRef.current]),
    // Size the box to the new total BEFORE the scroll is written, or the
    // browser clamps an anchor correction to the old height (upstream L425-428).
    scrollToFn: (offset, options, instance) => {
      const box = boxRef.current;
      if (box) box.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, options, instance);
    },
    measureElement: (element, entry, instance) => {
      const size = measureElementDefault(element, entry, instance);
      pinVisibleOnBigResize(
        instance,
        element,
        size,
        scrollElementRef,
        resizePinnedRef,
        resizePinFrameRef,
      );
      return size;
    },
    ...virtualizerTestSeam,
  });
  // Read by virtual-core inside `resizeItem`, which the item refs call during
  // commit — before this component's own effects — so it is set in render.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
    shouldAdjustForResize({
      following: isFollowing(scrollElementRef.current),
      itemIndex: item.index,
      rangeStartIndex: virtualizer.range?.startIndex,
    });

  // Box offset → scrollMargin (content space, scroll-invariant). Runs after
  // EVERY commit on purpose — what sits above the box changes without any
  // prop of this list changing — and writes state only on a change, so it
  // cannot loop.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const margin = contentOffsetTop(box, scrollElement);
    if (margin !== scrollMargin) setScrollMargin(margin);
  });

  // Cold → warm overscan, two frames after the first paint (upstream L510-519).
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setRenderOverscan(RENDER_OVERSCAN_WARM));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      if (resizePinFrameRef.current !== undefined) {
        cancelAnimationFrame(resizePinFrameRef.current);
      }
    };
  }, []);

  // A session switch under one mounted list: drop the previous session's sizes;
  // on the way out, remember this session's for its next mount.
  const measuredSessionRef = useRef(sessionId);
  useEffect(() => {
    if (measuredSessionRef.current === sessionId) return;
    measuredSessionRef.current = sessionId;
    virtualizer.measure();
  }, [sessionId, virtualizer]);
  useEffect(() => {
    return () => rememberTimelineMeasurements(sessionId, virtualizer.takeSnapshot());
  }, [sessionId, virtualizer]);

  // The host API. Closures read the latest list through refs.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const indexByIdRef = useRef(indexById);
  indexByIdRef.current = indexById;
  const keyOfRef = useRef(getItemKey);
  keyOfRef.current = getItemKey;
  useLayoutEffect(() => {
    if (!apiRef) return;
    const turnIndex = (turnId: string) => indexByIdRef.current.get(turnId);
    apiRef.current = {
      turnIndex,
      turnStart: (turnId) => {
        const index = turnIndex(turnId);
        if (index === undefined) return undefined;
        // `getTotalSize()` refreshes `measurementsCache` (the typed API keeps
        // `getMeasurements` private).
        virtualizer.getTotalSize();
        return virtualizer.measurementsCache[index]?.start;
      },
      turnAtOffset: (offset) => {
        const item = virtualizer.getVirtualItemForOffset(offset);
        if (!item) return undefined;
        return groupsRef.current[item.index]?.userMessageID;
      },
      isMounted: (turnId) => {
        const index = turnIndex(turnId);
        if (index === undefined) return false;
        const node = virtualizer.elementsCache.get(keyOfRef.current(index));
        return !!node && node.isConnected;
      },
      scrollToTurn: (turnId, options) => {
        const index = turnIndex(turnId);
        if (index === undefined) return false;
        virtualizer.scrollToIndex(index, {
          align: options?.align ?? 'start',
          behavior: options?.behavior ?? 'auto',
        });
        return true;
      },
      measure: () => virtualizer.measure(),
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={boxRef}
      data-timeline-virtual
      style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
    >
      {items.map((item) => {
        const group = groups[item.index];
        if (!group) return null;
        const turn = turnsById.get(group.userMessageID);
        if (!turn) return null;
        return (
          <VirtualTurnItem
            key={item.key}
            item={item}
            scrollMargin={scrollMargin}
            measureElement={virtualizer.measureElement}
            gapBelowClass={turnGapBelowClass({
              index: item.index,
              count: groups.length,
              userMessageID: group.userMessageID,
              nextUserMessageID: groups[item.index + 1]?.userMessageID,
              lastTurnWorking: sessionWorking,
              pendingTurnIds,
            })}
          >
            <TurnFrame
              group={group}
              turn={turn}
              className=""
              contain={false}
              pricingLookup={pricingLookup}
              density={density}
              list={list}
            />
          </VirtualTurnItem>
        );
      })}
    </div>
  );
}

/**
 * `node`'s top in `scrollElement`'s content space: the rect difference plus
 * `scrollTop` (scroll-invariant). A node with no layout box (happy-dom, a
 * hidden tab) reports 0 — there is nothing measurable above it, and the value
 * only matters once the box has a height.
 */
function contentOffsetTop(node: HTMLElement, scrollElement: HTMLElement): number {
  const rect = node.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) return 0;
  return Math.round(rect.top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop);
}

/**
 * One turn grew (or shrank) by more than a viewport: keep the indexes visible
 * right now mounted for two frames, so the scroll correction lands on a list
 * that still renders them instead of on a freshly computed window.
 */
function pinVisibleOnBigResize(
  instance: TurnVirtualizer,
  element: HTMLDivElement,
  size: number,
  scrollElementRef: React.RefObject<HTMLDivElement>,
  resizePinnedRef: React.RefObject<number[]>,
  resizePinFrameRef: React.RefObject<number | undefined>,
): void {
  const root = scrollElementRef.current;
  if (!root) return;
  const index = instance.indexFromElement(element);
  if (index < 0) return;
  const previous = instance.itemSizeCache.get(instance.options.getItemKey(index));
  if (previous === undefined || Math.abs(size - previous) <= root.clientHeight) return;
  const view = root.getBoundingClientRect();
  resizePinnedRef.current = Array.from(root.querySelectorAll<HTMLElement>('[data-index]'))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > view.top && rect.top < view.bottom;
    })
    .map((node) => Number(node.dataset.index));
  if (resizePinFrameRef.current !== undefined) cancelAnimationFrame(resizePinFrameRef.current);
  resizePinFrameRef.current = requestAnimationFrame(() => {
    resizePinFrameRef.current = requestAnimationFrame(() => {
      resizePinFrameRef.current = undefined;
      resizePinnedRef.current = [];
    });
  });
}

/**
 * One virtual item: an absolutely positioned, height-clipped slot at the
 * item's `start`, around the measured box (`data-index`) that holds the turn
 * and the gap below it. `overflow-y: clip` hides the one frame between a turn
 * growing and the virtualizer re-rendering its slot; `overflow-x` stays
 * visible so hover chrome that extends past the column is not cut.
 */
function VirtualTurnItem({
  item,
  scrollMargin,
  measureElement,
  gapBelowClass,
  children,
}: {
  item: VirtualItem;
  scrollMargin: number;
  measureElement: TurnVirtualizer['measureElement'];
  gapBelowClass: string;
  children: React.ReactNode;
}) {
  const measuredRef = useRef<HTMLDivElement | null>(null);
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      measuredRef.current = node;
      measureElement(node);
    },
    [measureElement],
  );
  // A turn that moved to another index (a prepend above it) is re-measured
  // under its new `data-index` (upstream L1250-1258).
  useLayoutEffect(() => {
    if (measuredRef.current) measureElement(measuredRef.current);
  }, [item.index, measureElement]);

  return (
    <div
      data-timeline-key={String(item.key)}
      style={{
        position: 'absolute',
        top: item.start - scrollMargin,
        left: 0,
        width: '100%',
        height: item.size,
        overflowX: 'visible',
        overflowY: 'clip',
        overflowClipMargin: '0.5px',
      }}
    >
      <div ref={attach} data-index={item.index} className={gapBelowClass || undefined}>
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// TurnFrameContext — the per-turn hooks, read by the tail row only
// ============================================================================

interface TurnFrameContextValue {
  statusPhrase: string;
  statusElapsedLabel: string | undefined;
  retrySecondsLeft: number;
  copied: boolean;
  onCopy: () => void;
  connectProviderOpen: boolean;
  setConnectProviderOpen: (open: boolean) => void;
}

const TurnFrameContext = createContext<TurnFrameContextValue | null>(null);

// ============================================================================
// TurnFrame
// ============================================================================

interface TurnFrameProps {
  group: TurnRowGroup;
  turn: Turn;
  className: string;
  /** `false` inside the virtual list — see `TurnViewport`. */
  contain?: boolean;
  pricingLookup: ReturnType<typeof useModelPricingLookup>;
  density: ConversationDensity;
  list: SessionTimelineListProps;
}

/**
 * `memo`'d on `sameTurnFrameProps` (turn-frame-memo.ts): `group` and `turn`
 * by identity, the list facts by what THIS turn reads. Every `list.*` read in
 * the body below must have a line in that comparator.
 */
function TurnFrameImpl({
  group,
  turn,
  className,
  contain = true,
  pricingLookup,
  density,
  list,
}: TurnFrameProps) {
  const { userMessageID } = group;
  const {
    sessionId,
    sessionStatus,
    permissions,
    questions,
    sessionWorking,
    workingTurnId,
    commandMessages,
    commands,
    disableToolNavigation,
    onPermissionReply,
    providers,
    onRowRender,
  } = list;

  // Test seam: one `frame:<turn>` per body run, beside the rows' own keys.
  onRowRender?.(`frame:${userMessageID}`);

  const isWorkingTurn = userMessageID === workingTurnId;
  // The WORKING turn's working state is the session's, and the parent resolved
  // that answer once (`resolveLastTurnWorking`): the projection
  // (`useSessionWorking` → `GET .../turn`) for a Kortix session, the raw SSE
  // slot only for a child session with no `/turn` row. Any other turn is
  // NEVER working — that is a fact about the transcript, not an observation,
  // and it is what removes the "last turn shimmers for ever" symptom the raw
  // slot's dropped end-of-turn frames caused here.
  const working = isWorkingTurn && sessionWorking;

  const view = deriveTurnView(turn, {
    sessionId,
    questions,
    working,
    commandMessages,
    commands,
    pricingLookup,
  });

  const [copied, setCopied] = useState(false);
  const [connectProviderOpen, setConnectProviderOpen] = useState(false);

  // Retry info (only on the working turn). These KEEP reading the raw
  // `sessionStatus` frame on purpose: they render the retry *reason* carried on
  // the frame (attempt count, provider message, next-retry time), which the
  // working projection does not carry.
  const retryInfo = useMemo(
    () => (isWorkingTurn ? getRetryInfo(sessionStatus) : undefined),
    [sessionStatus, isWorkingTurn],
  );
  const retryMessage = useMemo(
    () => (isWorkingTurn ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, isWorkingTurn],
  );

  // ---- Status throttling (2.5s) ----
  const { allParts } = view;
  const [statusThrottleStart] = useState(() => Date.now());
  const lastStatusChangeRef = useRef(statusThrottleStart);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const childMessages = undefined as MessageWithParts[] | undefined; // placeholder for child session delegation
  const rawStatus = useMemo(
    () => getTurnStatus(allParts, childMessages),
    [allParts, childMessages],
  );
  const [throttledStatus, setThrottledStatus] = useState('');
  // How long the status has read the same thing. Past STATUS_STALL_AFTER_MS
  // the label carries the elapsed time, so a slow model step or a long tool
  // call reads as "still working, this long" instead of a frozen screen.
  const [statusSinceMs, setStatusSinceMs] = useState(() => Date.now());
  const [statusElapsedMs, setStatusElapsedMs] = useState(0);
  useEffect(() => {
    setStatusSinceMs(Date.now());
    setStatusElapsedMs(0);
  }, [throttledStatus]);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setStatusElapsedMs(Date.now() - statusSinceMs), 1000);
    return () => clearInterval(timer);
  }, [working, statusSinceMs]);
  /** The phrase alone — never the elapsed time. Folding the ticking duration in
   *  here changed the busy indicator's animation key once a second, which
   *  replayed its roll-swap forever during any long tool call. */
  const statusPhrase =
    throttledStatus && working && statusElapsedMs >= STATUS_STALL_AFTER_MS
      ? throttledStatus.replace(/(\.\.\.|…)$/, '')
      : throttledStatus;
  const statusElapsedLabel =
    throttledStatus && working && statusElapsedMs >= STATUS_STALL_AFTER_MS
      ? formatDuration(statusElapsedMs)
      : undefined;

  useEffect(() => {
    const newStatus = rawStatus;
    if (newStatus === throttledStatus || !newStatus) return;
    const elapsed = Date.now() - lastStatusChangeRef.current;
    if (elapsed >= 2500) {
      setThrottledStatus(newStatus);
      lastStatusChangeRef.current = Date.now();
    } else {
      clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = setTimeout(() => {
        setThrottledStatus(getTurnStatus(allParts, childMessages));
        lastStatusChangeRef.current = Date.now();
      }, 2500 - elapsed);
    }
    return () => clearTimeout(statusTimeoutRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParts, rawStatus, throttledStatus]);

  // ---- Retry countdown ----
  const [retrySecondsLeft, setRetrySecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryInfo) {
      setRetrySecondsLeft(0);
      return;
    }
    const update = () =>
      setRetrySecondsLeft(Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [retryInfo]);

  // ---- Copy response ----
  const { inlineContentParts, response } = view;
  const onCopy = useCallback(() => {
    // When inline content is active, copy all text parts (not just the last one)
    const textToCopy = inlineContentParts
      ? inlineContentParts
          .flatMap((item) => {
            if (item.type !== 'text') return [];
            const text = (item.part as TextPart).text?.trim();
            return text ? [text] : [];
          })
          .join('\n\n')
      : response;
    if (!textToCopy) return;
    void navigator.clipboard.writeText(textToCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [inlineContentParts, response]);

  // ---- Projection ----
  // One projection cache per turn frame, for the life of the frame.
  const [cache] = useState(createProjectionCache);
  const placements = useMemo(
    () =>
      projectTurnPlacements(
        group,
        turn,
        view,
        {
          sessionId,
          disableNavigation: !!disableToolNavigation,
          density,
          permissions,
          onPermissionReply,
        },
        cache,
      ),
    [
      group,
      turn,
      view,
      sessionId,
      disableToolNavigation,
      density,
      permissions,
      onPermissionReply,
      cache,
    ],
  );

  const frameContext = useMemo<TurnFrameContextValue>(
    () => ({
      statusPhrase,
      statusElapsedLabel,
      retrySecondsLeft,
      copied,
      onCopy,
      connectProviderOpen,
      setConnectProviderOpen,
    }),
    [statusPhrase, statusElapsedLabel, retrySecondsLeft, copied, onCopy, connectProviderOpen],
  );

  const bubbleRow = group.rows.find(
    (row): row is TimelineUserMessageRow => timelineRowSlot(row) === 'bubble',
  );

  // Only the working turn with no error, or a retrying turn, draws the
  // busy footer — see `showTurnBusyIndicator`.
  const showBusy = showTurnBusyIndicator({
    working,
    hasError: !!view.turnError,
    isRetrying: !!retryInfo,
  });

  return (
    <TurnFrameContext.Provider value={frameContext}>
      <TurnViewport turnId={userMessageID} className={className} contain={contain}>
        {/* Compaction divider — shown before the first turn after compaction */}
        {view.hasCompaction && <CompactionDivider />}

        {placements.shell ? (
          // ================================================================
          // Shell mode — short-circuit rendering
          // ================================================================
          <div className="space-y-1">
            <AssistantPartRow placement={placements.shell} onRowRender={onRowRender} />
            {view.turnError && (
              <TurnErrorDisplay
                errorText={view.turnError}
                errorDetails={view.turnErrorDetails}
                isAbort={view.turnErrorIsAbort}
                abortReason={view.turnErrorAbortReason}
                className="mt-2"
              />
            )}
            <ConnectProviderDialog
              open={connectProviderOpen}
              onOpenChange={setConnectProviderOpen}
              providers={providers}
            />
          </div>
        ) : view.isCompactionCard ? (
          // ================================================================
          // Compaction mode — render as a distinct card, no user bubble / logo / steps
          // ================================================================
          <div className="group/turn">
            <div className="border-border/60 bg-card/50 overflow-hidden rounded-md border">
              <div className="border-border/40 bg-muted/40 flex items-center gap-2 border-b px-4 py-2.5">
                <Layers className="text-muted-foreground/70 size-3.5" />
                <span className="text-muted-foreground/70 text-xs font-medium tracking-wider uppercase">
                  Compaction
                </span>
              </div>
              <div className="text-muted-foreground/90 [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_strong]:text-foreground/90 px-4 py-3 text-sm">
                <SandboxUrlDetector content={view.response} isStreaming={false} />
              </div>
            </div>
          </div>
        ) : (
          // ================================================================
          // Normal mode rendering — 1:1 port of SolidJS session-turn.tsx
          //
          // Structure:
          //   1. User message + actions
          //   2. Steps (bursts / standalone tools / prose) — if working || hasSteps || hasReasoning
          //   3. Screen-reader completion line
          //   4. Response section (ONLY when NOT working) or the inline list
          //   5. Answered question fallback, busy footer, error, copy + meta
          //
          // The response (last text part) is NEVER rendered twice:
          //   - While working: it renders INSIDE steps as a regular text part
          //   - When done: it's HIDDEN from steps and shown below as Response
          // ================================================================
          <div className="group/turn text-factor-[2] space-y-2.5">
            {bubbleRow && (
              <UserMessageRow
                key={aliasRowKey(bubbleRow, (id) => list.turnRenderKeys.get(id))}
                userMessageID={userMessageID}
                message={turn.userMessage}
                sessionReport={view.sessionReport}
                systemMessages={view.systemMessages}
                hasVisibleUserContent={view.hasVisibleUserContent}
                agentNames={list.agentNames}
                commandInfo={commandMessages?.get(userMessageID)}
                commands={commands}
                sessionId={sessionId}
                ownsPlan={userMessageID === list.planAnchorId}
                onRewind={list.onRewind}
                rewindDisabled={list.rewindDisabled}
                pending={sessionWorking && list.pendingTurnIds.has(userMessageID)}
                interruptedBeforeRun={list.interruptedTurnIds.has(userMessageID)}
                queueRow={list.inboxRowsByMessageId.get(userMessageID) ?? null}
                queueHeld={list.queueHeld}
                onQueueRemove={list.onQueueRemove}
                onQueueSendNow={list.onQueueSendNow}
                onQueueRetry={list.onQueueRetry}
                onRowRender={onRowRender}
              />
            )}

            {/* ── Assistant parts content ──
                Bursts (collapsed activity), standalone parts (deliverables,
                sub-agents, and any part with a pending permission), and text
                (prose between bursts) — see `projectTurnPlacements`. */}
            {view.showStepsBlock && (
              <div className="space-y-3">
                {placements.steps.map((placement) => (
                  <AssistantPartRow
                    key={placement.key}
                    placement={placement}
                    onRowRender={onRowRender}
                  />
                ))}
              </div>
            )}

            {/* ── Screen reader ──
                Announce COMPLETION only. Mirroring the full response here duplicated
                every turn in the DOM, so select-all across the transcript copied each
                answer twice. The visible markdown is already in the a11y tree. */}
            <div className="sr-only" aria-live="polite">
              {!working && view.response ? 'Response complete' : ''}
            </div>

            {/* Inline content: text and answered questions rendered in natural order.
                Works both during streaming and after completion. Otherwise the
                single response block (streaming while working). */}
            {view.shouldUseInlineContent ? (
              <div className="space-y-3">
                {placements.body.map((placement) => (
                  <AssistantPartRow
                    key={placement.key}
                    placement={placement}
                    onRowRender={onRowRender}
                  />
                ))}
              </div>
            ) : (
              placements.body.map((placement) => (
                <AssistantPartRow
                  key={placement.key}
                  placement={placement}
                  onRowRender={onRowRender}
                />
              ))
            )}

            <TurnTailRow
              userMessageID={userMessageID}
              sessionId={sessionId}
              working={working}
              showBusy={showBusy}
              retryInfo={retryInfo}
              retryMessage={retryMessage}
              turnError={view.turnError}
              turnErrorDetails={view.turnErrorDetails}
              turnErrorIsAbort={view.turnErrorIsAbort}
              turnErrorAbortReason={view.turnErrorAbortReason}
              // The copy button needs the response only once the turn settled;
              // keeping it off the props while streaming lets the tail bail on
              // every delta.
              copyText={working ? '' : view.response}
              // The inline list shows the questions itself (the legacy else
              // branch); the fallback is for the turn where nothing upstream
              // drew them.
              answeredFallbackParts={
                !view.shouldUseInlineContent &&
                !view.hasSteps &&
                !working &&
                !view.hasReasoning &&
                view.answeredQuestionParts.length > 0
                  ? view.answeredQuestionParts
                  : null
              }
              endedAt={view.turnEndedAt}
              durationMs={view.turnDurationMs}
              costInfo={view.costInfo}
              providers={providers}
              onRowRender={onRowRender}
            />
          </div>
        )}
      </TurnViewport>
    </TurnFrameContext.Provider>
  );
}

const TurnFrame = memo(TurnFrameImpl, sameTurnFrameProps);

// ============================================================================
// UserMessageRow
// ============================================================================

interface UserMessageRowProps {
  userMessageID: string;
  message: MessageWithParts;
  sessionReport: SessionReport | null;
  systemMessages: KortixSystemMessage[];
  hasVisibleUserContent: boolean;
  agentNames?: string[];
  commandInfo?: CommandInfo;
  commands?: Command[];
  sessionId: string;
  ownsPlan: boolean;
  onRewind: (messageId: string, text: string) => void;
  rewindDisabled: boolean;
  /**
   * A user message the agent has not reached yet — after the working turn,
   * with no assistant content. Drawn dimmed, like a queued prompt (it IS one:
   * the server forwarded it and OpenCode holds it until the next step), and
   * it fades up to full opacity the moment the agent takes it.
   */
  pending: boolean;
  /**
   * A Stop ended the turn before a step opened under this user message: the
   * runtime holds it and runs it with the next send. Drawn dimmed like any
   * queued prompt, with the meta row saying so.
   */
  interruptedBeforeRun: boolean;
  /**
   * The inbox row behind this turn's user message, while the row is still
   * live (queued, held, delivering, failed). Puts remove / send-now / retry
   * in the bubble's own meta row — the bubble IS the queue entry.
   */
  queueRow: SessionPrompt | null;
  queueHeld: boolean;
  onQueueRemove?: (promptId: string) => void;
  onQueueSendNow?: (promptId: string) => void;
  onQueueRetry?: (promptId: string) => void;
  onRowRender?: (key: string) => void;
}

function UserMessageRowImpl({
  userMessageID,
  message,
  sessionReport,
  systemMessages,
  hasVisibleUserContent,
  agentNames,
  commandInfo,
  commands,
  sessionId,
  ownsPlan,
  onRewind,
  rewindDisabled,
  pending,
  interruptedBeforeRun,
  queueRow,
  queueHeld,
  onQueueRemove,
  onQueueSendNow,
  onQueueRetry,
  onRowRender,
}: UserMessageRowProps) {
  onRowRender?.(`user:${userMessageID}`);
  const [sessionReportModalOpen, setSessionReportModalOpen] = useState(false);

  // The bubble is the queue entry: while its inbox row is live, the row's
  // state decides the controls in the bubble's meta row.
  const rowState: QueuedPromptState | null = !queueRow
    ? null
    : queueRow.state === 'failed'
      ? 'failed'
      : queueRow.state === 'delivering'
        ? 'in-flight'
        : queueRow.reason === 'held' || queueHeld
          ? 'held'
          : 'queued';
  // Only while the bubble is still WAITING (dimmed) — or has something to
  // say regardless (held, failed). A row that reads `delivering` for the rest
  // of the turn in front of it must not label a bubble the agent has reached.
  const queueState: QueuedPromptState | null =
    rowState && (pending || rowState === 'held' || rowState === 'failed')
      ? rowState
      : interruptedBeforeRun
        ? 'interrupted'
        : null;
  // The word under the bubble. A PENDING bubble says "Queued" even when its
  // inbox row is already closed (the runtime holds the message, the agent has
  // not reached it): the dim alone reads as "something is wrong".
  const statusState: QueuedPromptState | null = queueState ?? (pending ? 'queued' : null);
  // What the X removes: the row while it is listed, the message's own wire id
  // after the row left the list (the DELETE route resolves `msg_…` handles) —
  // for any bubble the agent has not reached.
  const queueRemovalId =
    onQueueRemove && statusState && statusState !== 'interrupted' && statusState !== 'failed'
      ? (queueRow?.prompt_id ?? userMessageID)
      : null;
  // Send-now / retry / remove all live in `UserMessageActions` (`leading`).
  // A pending bubble can outlive its inbox row; the X still has to work, so
  // the action id falls back to the user message's own wire id.
  const queueActionId = queueRemovalId ?? queueRow?.prompt_id ?? null;
  const showQueueActions =
    Boolean(queueActionId) &&
    (Boolean(queueRemovalId) || Boolean(queueRow && queueState && queueState !== 'interrupted'));

  return (
    <>
      {/* ── Session report card — clickable, opens worker session modal ── */}
      {sessionReport && (
        <>
          <SessionReportCard
            report={sessionReport}
            onOpen={() => setSessionReportModalOpen(true)}
          />
          <SubSessionModal
            open={sessionReportModalOpen}
            onOpenChange={setSessionReportModalOpen}
            sessionId={sessionReport.sessionId}
            title={`Worker${sessionReport.project ? ` · ${sessionReport.project}` : ''}`}
          />
        </>
      )}

      {/* ── System message indicator — shown for kortix_system-only messages ── */}
      {!hasVisibleUserContent && !sessionReport && systemMessages.length > 0 && (
        <SystemMessageIndicator messages={systemMessages} />
      )}

      {/* ── User message ── */}
      {/* Hide the user bubble when the user message has no visible content
			    (e.g. background task notification with only synthetic parts). */}
      {hasVisibleUserContent && (
        <div
          data-turn-pending={pending || interruptedBeforeRun || undefined}
          data-turn-queue-state={queueState ?? undefined}
          className={cn(
            'transition-opacity duration-500',
            (pending || interruptedBeforeRun) && QUEUED_BUBBLE_OPACITY_CLASS,
          )}
        >
          <UserMessage
            message={message}
            agentNames={agentNames}
            commandInfo={commandInfo}
            commands={commands}
            sessionId={sessionId}
            ownsPlan={ownsPlan}
            onRewind={onRewind}
            rewindDisabled={rewindDisabled}
            leadingStatus={
              statusState ? (
                <QueuedPromptStatus
                  state={statusState}
                  lastError={queueRow?.last_error ?? undefined}
                />
              ) : undefined
            }
            leadingActions={
              showQueueActions && queueActionId ? (
                <QueuedPromptActions
                  id={queueActionId}
                  state={queueState ?? statusState ?? 'queued'}
                  onRemove={queueRemovalId && onQueueRemove ? onQueueRemove : undefined}
                  onSendNow={onQueueSendNow}
                  onRetry={onQueueRetry}
                />
              ) : undefined
            }
            actionsAlwaysVisible={queueState === 'failed'}
          />
        </div>
      )}
    </>
  );
}

/**
 * Props are the message object (identity-stable for an unchanged message),
 * scalars, and stable callbacks — the default shallow compare is exact.
 */
export const UserMessageRow = memo(UserMessageRowImpl);
UserMessageRow.displayName = 'UserMessageRow';

// ============================================================================
// AssistantPartRow
// ============================================================================

function AssistantPartRowImpl({
  placement,
  onRowRender,
}: {
  placement: AssistantPartRowProps;
  onRowRender?: (key: string) => void;
}) {
  onRowRender?.(`part:${placement.key}`);
  const {
    role,
    parts,
    sessionId,
    working,
    isTrailing,
    disableNavigation,
    density,
    permission,
    onPermissionReply,
    commandForTurn,
    text,
    isStreaming,
  } = placement;

  switch (role) {
    case 'shell-only':
      return (
        <ToolPartRenderer
          part={parts[0] as ToolPart}
          sessionId={sessionId}
          disableNavigation={disableNavigation}
          permission={permission}
          onPermissionReply={onPermissionReply}
          defaultOpen
        />
      );
    case 'burst':
      return (
        <ActivityBurst
          parts={parts}
          sessionId={sessionId}
          working={working}
          isTrailing={isTrailing}
          disableNavigation={disableNavigation}
          density={density}
        />
      );
    case 'standalone': {
      const part = parts[0] as ToolPart;
      if (!shouldShowToolPart(part)) return null;
      return (
        <ToolPartRenderer
          part={part}
          sessionId={sessionId}
          disableNavigation={disableNavigation}
          permission={permission}
          onPermissionReply={onPermissionReply}
        />
      );
    }
    case 'text-step':
      return (
        <div className="min-w-0 text-sm">
          <ThrottledMarkdown content={text} isStreaming={isStreaming} />
        </div>
      );
    case 'response':
      if (isStreaming) {
        return (
          <div className="min-w-0 text-sm">
            <ThrottledMarkdown content={text} isStreaming />
          </div>
        );
      }
      return commandForTurn ? (
        <div className="space-y-2">
          <div className="bg-secondary flex w-full flex-col overflow-hidden rounded-lg">
            <div className="text-foreground flex min-w-0 items-center justify-between gap-2 p-3 pb-0 text-xs [&>svg]:size-4">
              <span
                className="bg-popover text-foreground/95 dark:bg-card min-w-0 truncate rounded-[calc(var(--radius-sm)-0.5px)] border px-1.5 py-[0.08rem] align-baseline font-mono text-[0.95em] font-medium wrap-anywhere whitespace-nowrap"
                title={`/${commandForTurn.name}`}
              >
                {commandForTurn.name}
              </span>
            </div>
            {/* Command output clamps to a readable height and opens from a
                centred toggle on the fade. `from-secondary` matches the
                panel this sits on — the gradient has to dissolve into the
                surface, not paint a band over it. */}
            <ExpandableOutput
              className="min-h-0"
              fadeClassName="from-secondary"
              contentClassName="px-4 py-3 text-sm"
            >
              <SandboxUrlDetector content={text} isStreaming={false} />
            </ExpandableOutput>
          </div>
          <CodeBlockEndpoints content={text} />
        </div>
      ) : (
        <div className="text-sm">
          <SandboxUrlDetector content={text} isStreaming={false} />
        </div>
      );
    case 'inline-text':
      return (
        <div className="min-w-0 text-sm">
          {isStreaming ? (
            <ThrottledMarkdown content={text} isStreaming />
          ) : (
            <SandboxUrlDetector content={text} isStreaming={false} />
          )}
        </div>
      );
    case 'inline-questions':
      return (
        <>
          {parts.map((part) => (
            <AnsweredQuestionCard key={part.id} part={part as ToolPart} />
          ))}
        </>
      );
    default: {
      const _never: never = role;
      return _never;
    }
  }
}

/** Scalars by identity, `parts` element-wise — `same-parts.ts`. */
export function sameAssistantPartRowProps(
  a: AssistantPartRowProps,
  b: AssistantPartRowProps,
): boolean {
  return (
    a.role === b.role &&
    a.sessionId === b.sessionId &&
    a.working === b.working &&
    a.isTrailing === b.isTrailing &&
    a.disableNavigation === b.disableNavigation &&
    a.density === b.density &&
    a.permission === b.permission &&
    a.onPermissionReply === b.onPermissionReply &&
    a.commandForTurn === b.commandForTurn &&
    a.text === b.text &&
    a.isStreaming === b.isStreaming &&
    samePartsList(a.parts, b.parts)
  );
}

export const AssistantPartRow = memo(
  AssistantPartRowImpl,
  (a, b) => a.onRowRender === b.onRowRender && sameAssistantPartRowProps(a.placement, b.placement),
);
AssistantPartRow.displayName = 'AssistantPartRow';

// ============================================================================
// TurnTailRow — host-synthesized: what follows the parts in every turn
// ============================================================================

interface TurnTailRowProps {
  userMessageID: string;
  sessionId: string;
  working: boolean;
  showBusy: boolean;
  retryInfo: ReturnType<typeof getRetryInfo>;
  retryMessage: string | undefined;
  turnError: string | undefined;
  turnErrorDetails: TurnView['turnErrorDetails'];
  turnErrorIsAbort: boolean;
  turnErrorAbortReason: string | undefined;
  /** The response to copy — `''` while working (no copy button then). */
  copyText: string;
  /** The answered cards shown when NO upstream renderer fires, else null. */
  answeredFallbackParts: TurnView['answeredQuestionParts'] | null;
  endedAt: TurnView['turnEndedAt'];
  durationMs: TurnView['turnDurationMs'];
  costInfo: TurnCostInfo | undefined;
  providers?: ProviderListResponse;
  onRowRender?: (key: string) => void;
}

function TurnTailRowImpl({
  userMessageID,
  sessionId,
  working,
  showBusy,
  retryInfo,
  retryMessage,
  turnError,
  turnErrorDetails,
  turnErrorIsAbort,
  turnErrorAbortReason,
  copyText,
  answeredFallbackParts,
  endedAt,
  durationMs,
  costInfo,
  providers,
  onRowRender,
}: TurnTailRowProps) {
  onRowRender?.(`tail:${userMessageID}`);
  const tHardcodedUi = useTranslations('hardcodedUi');
  const frame = useContext(TurnFrameContext);
  const statusPhrase = frame?.statusPhrase ?? '';
  const statusElapsedLabel = frame?.statusElapsedLabel;
  const retrySecondsLeft = frame?.retrySecondsLeft ?? 0;
  const copied = frame?.copied ?? false;

  return (
    <>
      {/* Answered question parts — shown after the response text only when
          NONE of the upstream renderers fire. The steps section above is
          gated by `working || hasSteps || hasReasoning`; if any of those
          is true, the question parts have already been rendered inline
          there as AnsweredQuestionCards. Mirroring that guard's inverse
          here is the only way to avoid the double-render that showed up
          on interrupted sessions that contained reasoning but no tool
          steps (e.g. "Planning a process for questions" → user answers
          → interrupt; hasSteps=false, working=false, hasReasoning=true,
          and without the !hasReasoning check the card rendered twice). */}
      {answeredFallbackParts && (
        <div className="mt-3 space-y-2">
          {answeredFallbackParts.map(({ part }) => (
            <AnsweredQuestionCard key={part.id} part={part as ToolPart} />
          ))}
        </div>
      )}

      {/* ── Working status indicator (always at the end while working) ── */}
      {showBusy && (
        <div className="space-y-2">
          {retryInfo && retryMessage && (
            <SessionRetryDisplay
              message={retryMessage}
              attempt={retryInfo.attempt}
              secondsLeft={retrySecondsLeft}
              details={retryInfo.details}
            />
          )}
          <SessionBusyIndicator
            sessionId={sessionId}
            statusText={statusPhrase || undefined}
            elapsedLabel={statusElapsedLabel}
            retryLabel={
              retryInfo
                ? String(
                    tHardcodedUi.raw('componentsSessionSessionChat.line3820JsxTextWaitingToRetry'),
                  )
                : undefined
            }
          />
        </div>
      )}

      {/* ── Error (abort / failure banner) ── */}
      {turnError && (
        <TurnErrorDisplay
          errorText={turnError}
          errorDetails={turnErrorDetails}
          isAbort={turnErrorIsAbort}
          abortReason={turnErrorAbortReason}
        />
      )}

      {/* Question prompt — now rendered inside the chat input card (questionSlot) */}

      {/* ── Action bar (copy + turn meta) ──
          Gated on `!working` only. A turn that ends in tool calls has no closing
          prose, but its finished-at / duration / cost are still turn facts —
          `SessionTurnMeta` self-hides when it has no rows. Only the copy button
          needs a response to copy.

          `max-md:opacity-100` — same rule as the user turn's meta row
          (`turn/user-message.tsx`): hover-to-reveal is a desktop affordance.
          On touch there is no hover, so Copy and the turn's finished-at /
          duration / cost would be permanently invisible, and tap-emulated
          `:hover` would leave exactly one arbitrary turn's bar lit. */}
      {!working && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100">
          {copyText ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={frame?.onCopy}
              aria-label={copied ? 'Copied' : 'Copy response'}
              className="hit-area-3"
            >
              <span className="relative inline-flex shrink-0 items-center justify-center">
                <AnimatePresence initial={false} mode="popLayout">
                  <m.span
                    key={copied ? 'check' : 'copy'}
                    initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                    animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                    exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                    transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                    className="absolute inset-0 inline-flex items-center justify-center"
                  >
                    {copied ? (
                      <CheckIcon className="text-foreground/70 size-[1.05rem]" />
                    ) : (
                      <Copy className="text-foreground/70 size-[1.05rem]" />
                    )}
                  </m.span>
                </AnimatePresence>
              </span>
            </Button>
          ) : null}
          <SessionTurnMeta
            endedAt={endedAt}
            durationMs={durationMs}
            cost={costInfo}
            className="flex items-center justify-center"
          />
        </div>
      )}

      <ConnectProviderDialog
        open={frame?.connectProviderOpen ?? false}
        onOpenChange={frame?.setConnectProviderOpen ?? (() => {})}
        providers={providers}
      />
    </>
  );
}

/**
 * Re-renders with its turn's scalars (only the streaming turn's change, via
 * `stabilizeTurns` → `deriveTurnView`) and with `TurnFrameContext` (the
 * tickers), which bypasses memo by design.
 */
export const TurnTailRow = memo(TurnTailRowImpl);
TurnTailRow.displayName = 'TurnTailRow';
