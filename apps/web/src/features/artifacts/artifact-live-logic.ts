/**
 * Live presence on an Artifact (KRTX-3669), framework-free: who is here (one
 * row per person or agent session), whose cursor to draw, who types where, and
 * the two timers the viewer runs (send pacing and the typing idle). The SDK
 * hook owns the socket; this module only reads its participant list.
 */
import type {
  ArtifactLiveColor,
  ArtifactLiveParticipant,
  ArtifactLiveStatus,
  ArtifactLiveTyping,
} from '@kortix/sdk';

/** Faces in the header before the rest collapse into "+N". */
export const LIVE_STACK_LIMIT = 4;
/** A typing signal ends this long after the last keystroke. */
export const LIVE_TYPING_IDLE_MS = 2_000;
/** Own caret and pointer sends are paced to this interval (the SDK coalesces too). */
export const LIVE_SEND_MS = 100;

/** One person (all their tabs) or one agent session on the Artifact. */
export interface LiveMember {
  /** `user:<user_id>` or `session:<session_id>`. */
  key: string;
  kind: 'user' | 'session';
  name: string;
  avatarUrl: string | null;
  /** The color of the member's first connection (sorted by participant id). */
  color: ArtifactLiveColor;
  /** The most active status across the member's connections. */
  status: ArtifactLiveStatus;
  /** The signed-in viewer (this tab or another tab of the same person). */
  you: boolean;
}

/** People first, then agents; within each, the viewer first, then by name. */
export interface LiveMembers {
  you: LiveMember | null;
  /** Everyone except the viewer, people before agents: the header stack. */
  others: LiveMember[];
}

const STATUS_RANK: Record<ArtifactLiveStatus, number> = {
  viewing: 0,
  reading: 1,
  editing: 2,
  writing: 3,
};

export const memberKey = (participant: Pick<ArtifactLiveParticipant, 'who'>): string =>
  participant.who.kind === 'user'
    ? `user:${participant.who.user_id}`
    : `session:${participant.who.session_id}`;

/** This connection, or another tab of the signed-in person. */
export function isViewer(
  participant: Pick<ArtifactLiveParticipant, 'id' | 'who'>,
  you: string | null,
  viewerId: string | null | undefined,
): boolean {
  if (you !== null && participant.id === you) return true;
  return !!viewerId && participant.who.kind === 'user' && participant.who.user_id === viewerId;
}

/**
 * One row per `who`: a person with three tabs is one avatar, an agent session is
 * one avatar. The status is the most active one of the member's connections.
 */
export function groupLiveMembers(
  participants: readonly ArtifactLiveParticipant[],
  you: string | null,
  viewerId: string | null | undefined,
): LiveMembers {
  const sorted = [...participants].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byKey = new Map<string, LiveMember>();
  for (const participant of sorted) {
    const key = memberKey(participant);
    const viewer = isViewer(participant, you, viewerId);
    const existing = byKey.get(key);
    if (existing) {
      if (STATUS_RANK[participant.status] > STATUS_RANK[existing.status])
        existing.status = participant.status;
      existing.you ||= viewer;
      existing.avatarUrl ??= participant.avatar_url;
      continue;
    }
    byKey.set(key, {
      key,
      kind: participant.who.kind,
      name: participant.name,
      avatarUrl: participant.avatar_url,
      color: participant.color,
      status: participant.status,
      you: viewer,
    });
  }
  const members = [...byKey.values()];
  const byName = (a: LiveMember, b: LiveMember) =>
    a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1);
  const others = members
    .filter((member) => !member.you)
    .sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'user' ? -1 : 1));
  return { you: members.find((member) => member.you) ?? null, others };
}

/** The header stack: at most `limit` faces, the rest behind "+N". */
export function liveStack<T>(members: readonly T[], limit = LIVE_STACK_LIMIT) {
  const shown = members.slice(0, limit);
  return { shown, more: members.length - shown.length };
}

/**
 * The connections whose cursor and selection this viewer draws: everyone else
 * on the same view, never the viewer's own tabs and never a hidden participant.
 */
export function remotePeers(
  participants: readonly ArtifactLiveParticipant[],
  you: string | null,
  viewerId: string | null | undefined,
  view: 'doc' | 'page',
): ArtifactLiveParticipant[] {
  return participants.filter(
    (participant) =>
      !isViewer(participant, you, viewerId) &&
      !participant.hidden &&
      // An agent has no view: it is placed by what it does, on either view.
      (participant.view === view || participant.who.kind === 'session'),
  );
}

export const typingKey = (where: ArtifactLiveTyping): string =>
  typeof where === 'string' ? where : `thread:${where.thread_id}`;

/**
 * The names of the people typing at `where`, one per person, viewer excluded.
 * Agents write instead of typing: `agentsAt` reports them.
 */
export function typingNames(
  participants: readonly ArtifactLiveParticipant[],
  you: string | null,
  viewerId: string | null | undefined,
  where: ArtifactLiveTyping,
): string[] {
  const key = typingKey(where);
  const names = new Map<string, string>();
  for (const participant of participants) {
    if (
      participant.who.kind !== 'user' ||
      participant.hidden ||
      !participant.typing ||
      typingKey(participant.typing) !== key ||
      isViewer(participant, you, viewerId)
    )
      continue;
    names.set(memberKey(participant), participant.name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/** An agent session placed on a thread: its label shows there. */
export interface LiveAgentPlace {
  key: string;
  name: string;
  color: ArtifactLiveColor;
  status: ArtifactLiveStatus;
}

/** The agent sessions whose focus is `threadId`, or that write in it. */
export function agentsAt(
  participants: readonly ArtifactLiveParticipant[],
  threadId: string,
): LiveAgentPlace[] {
  const agents = new Map<string, LiveAgentPlace>();
  for (const participant of participants) {
    if (participant.who.kind !== 'session') continue;
    const writingHere =
      !!participant.typing &&
      typeof participant.typing !== 'string' &&
      participant.typing.thread_id === threadId;
    if (participant.focus !== threadId && !writingHere) continue;
    agents.set(memberKey(participant), {
      key: memberKey(participant),
      name: participant.name,
      color: participant.color,
      status: writingHere ? 'writing' : participant.status,
    });
  }
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface LiveTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: LiveTimers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One typing place (a reply box, the new-comment composer, the doc): `input()`
 * on each edit sends `true` once, and `false` after `idleMs` with no edit.
 * `stop()` (blur, send, unmount) ends it at once.
 */
export function createTypingSignal(
  send: (active: boolean) => void,
  options: { idleMs?: number; timers?: LiveTimers } = {},
) {
  const timers = options.timers ?? realTimers;
  const idleMs = options.idleMs ?? LIVE_TYPING_IDLE_MS;
  let active = false;
  let timer: unknown = null;
  const clear = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const stop = () => {
    clear();
    if (!active) return;
    active = false;
    send(false);
  };
  return {
    input() {
      if (!active) {
        active = true;
        send(true);
      }
      clear();
      timer = timers.set(() => {
        timer = null;
        stop();
      }, idleMs);
    },
    stop,
    get active() {
      return active;
    },
  };
}

/**
 * The server keeps one typing place per connection, and `active: false`
 * clears it whatever the place. So a stop from a place this tab already left
 * (a blur that lands after the next field's first keystroke) is dropped:
 * only the current place may clear it.
 */
export function createTypingOwner(send: (where: ArtifactLiveTyping, active: boolean) => void) {
  let current: string | null = null;
  return (where: ArtifactLiveTyping, active: boolean) => {
    const key = typingKey(where);
    if (active) {
      current = key;
      send(where, true);
    } else if (current === key) {
      current = null;
      send(where, false);
    }
  };
}

/**
 * Paces a stream of values to one send per `ms`: the first goes at once, then
 * the newest value waits for the interval. Equal consecutive values (by key) are
 * sent once. `flush()` sends a waiting value now.
 */
export function createPacedSender<T>(
  send: (value: T) => void,
  options: { ms?: number; timers?: LiveTimers; key?: (value: T) => string } = {},
) {
  const timers = options.timers ?? realTimers;
  const ms = options.ms ?? LIVE_SEND_MS;
  const key = options.key ?? ((value: T) => JSON.stringify(value));
  let last = -Infinity;
  let sentKey: string | undefined;
  let waiting: { value: T } | null = null;
  let timer: unknown = null;
  const emit = (value: T) => {
    const next = key(value);
    // An equal value sends nothing, so it does not use the interval either.
    if (next === sentKey) return;
    last = timers.now();
    sentKey = next;
    send(value);
  };
  const flush = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    if (!waiting) return;
    const { value } = waiting;
    waiting = null;
    emit(value);
  };
  return {
    push(value: T) {
      const wait = last + ms - timers.now();
      if (wait <= 0 && timer === null) {
        waiting = null;
        emit(value);
        return;
      }
      waiting = { value };
      if (timer === null) timer = timers.set(flush, Math.max(0, wait));
    },
    flush,
    /** Forget what was sent: the next value goes out even when it is equal (a reconnect). */
    reset() {
      sentKey = undefined;
    },
    dispose() {
      if (timer !== null) timers.clear(timer);
      timer = null;
      waiting = null;
    },
  };
}
