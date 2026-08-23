/**
 * The `memo` comparator of `TurnFrame` (session-timeline-list.tsx) — pure,
 * unit-tested (`turn-frame-memo.test.ts`).
 *
 * A `TurnFrame` takes the whole list props object as `list` and that object is
 * new on every `SessionChat` render, so `memo` alone would never hold. This
 * comparator compares what the frame BODY reads off it: a fixed list of facts
 * by identity (`IDENTITY_FACTS`), and the per-turn facts by the VALUE the frame
 * derives for ITS turn — `turnRenderKeys.get(id)`, `pendingTurnIds.has(id)`,
 * `planAnchorId === id` and so on — because the host rebuilds those containers
 * per frame (`useMemo` on `turns`) while the value for a settled turn does not
 * change. `sessionStatus` (the raw SSE frame) matters to the working turn only
 * (retry info); `sessionWorking` reaches the body only as
 * `working = isWorkingTurn && sessionWorking` and
 * `pending = sessionWorking && pendingTurnIds.has(id)`, so those products are
 * compared, not the flag — the session-wide busy flip reaches only the frames
 * whose own state changed.
 *
 * RULE: every read of `list.*` inside `TurnFrameImpl` has a line here. A new
 * read without one is a memo that holds too long (a stale frame); the test
 * file's table is the checklist.
 */

/** The host facts a `TurnFrame` body reads off the list props. */
export interface TurnFrameListFacts {
  sessionId: string;
  sessionStatus: unknown;
  permissions: readonly unknown[];
  questions: readonly unknown[];
  sessionWorking: boolean;
  workingTurnId: string | null;
  planAnchorId: string | null;
  agentNames?: readonly string[];
  providers?: unknown;
  commandMessages?: ReadonlyMap<string, unknown>;
  commands?: readonly unknown[];
  disableToolNavigation?: boolean;
  onPermissionReply: unknown;
  onRewind: unknown;
  rewindDisabled: boolean;
  onRowRender?: unknown;
  turnRenderKeys: ReadonlyMap<string, string>;
  pendingTurnIds: ReadonlySet<string>;
  interruptedTurnIds: ReadonlySet<string>;
  inboxRowsByMessageId: ReadonlyMap<string, unknown>;
  queueHeld: boolean;
  onQueueRemove: unknown;
  onQueueSendNow: unknown;
  onQueueRetry: unknown;
}

/** The props of `TurnFrame` this comparator sees. */
export interface TurnFrameMemoProps<L extends TurnFrameListFacts = TurnFrameListFacts> {
  group: { userMessageID: string };
  turn: unknown;
  className: string;
  contain?: boolean;
  pricingLookup: unknown;
  density: unknown;
  list: L;
}

/** Facts compared by identity (`Object.is`) — the frame hands them on whole. */
export const TURN_FRAME_IDENTITY_FACTS = [
  'sessionId',
  'permissions',
  'questions',
  'agentNames',
  'providers',
  'commandMessages',
  'commands',
  'disableToolNavigation',
  'onPermissionReply',
  'onRewind',
  'rewindDisabled',
  'onRowRender',
  'queueHeld',
  'onQueueRemove',
  'onQueueSendNow',
  'onQueueRetry',
] as const satisfies readonly (keyof TurnFrameListFacts)[];

export function sameTurnFrameProps<L extends TurnFrameListFacts>(
  prev: TurnFrameMemoProps<L>,
  next: TurnFrameMemoProps<L>,
): boolean {
  if (prev.group !== next.group) return false;
  if (prev.turn !== next.turn) return false;
  if (prev.className !== next.className) return false;
  if ((prev.contain ?? true) !== (next.contain ?? true)) return false;
  if (prev.pricingLookup !== next.pricingLookup) return false;
  if (prev.density !== next.density) return false;
  const a = prev.list;
  const b = next.list;
  if (a === b) return true;
  for (const key of TURN_FRAME_IDENTITY_FACTS) {
    if (!Object.is(a[key], b[key])) return false;
  }
  const id = next.group.userMessageID;
  // `isWorkingTurn`, `working` (→ view, busy footer, status tickers).
  const wasWorkingTurn = a.workingTurnId === id;
  const isWorkingTurn = b.workingTurnId === id;
  if (wasWorkingTurn !== isWorkingTurn) return false;
  if ((wasWorkingTurn && a.sessionWorking) !== (isWorkingTurn && b.sessionWorking)) return false;
  // `retryInfo` / `retryMessage` read the raw status frame on the working turn only.
  if (isWorkingTurn && a.sessionStatus !== b.sessionStatus) return false;
  // `UserMessageRow` props derived per turn.
  if (
    (a.sessionWorking && a.pendingTurnIds.has(id)) !==
    (b.sessionWorking && b.pendingTurnIds.has(id))
  ) {
    return false;
  }
  if (a.interruptedTurnIds.has(id) !== b.interruptedTurnIds.has(id)) return false;
  if (a.inboxRowsByMessageId.get(id) !== b.inboxRowsByMessageId.get(id)) return false;
  if ((a.planAnchorId === id) !== (b.planAnchorId === id)) return false;
  // The bubble row's React key (`aliasRowKey`).
  if (a.turnRenderKeys.get(id) !== b.turnRenderKeys.get(id)) return false;
  return true;
}
