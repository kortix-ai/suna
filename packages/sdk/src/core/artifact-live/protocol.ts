/**
 * The live protocol of an Artifact (KRTX-3669): presence and change pings over
 * one WebSocket per open Artifact. It carries no comment body and no Artifact
 * content: those always come through REST, with its permission checks.
 *
 * `@kortix/sdk` is published and cannot depend on the private `@kortix/shared`,
 * whose `artifact-live` module (zod schemas) is the contract. This file is the
 * SDK's copy, written without zod (an optional peer here).
 * `protocol.test.ts` holds the two equal: the constants, the types, and the
 * verdict of both parsers over one corpus of valid and invalid frames.
 */

export const ARTIFACT_LIVE_VERSION = 1;

export const ARTIFACT_LIVE_LIMITS = {
  /** Largest frame in either direction, in bytes (pg_notify allows 8 KB). */
  frameBytes: 1024,
  /** Frames a client may send per second; the rest are dropped. */
  clientFramesPerSecond: 10,
  /** Cursor or selection relays per socket per second across servers. */
  relayFramesPerSecond: 5,
  /** Participants who send presence; anyone beyond sees presence but sends none. */
  participants: 50,
  /** A client pings this often; the server drops a participant silent for expireMs. */
  heartbeatMs: 25_000,
  expireMs: 45_000,
  /** A ticket works once, for this long after it is minted. */
  ticketMs: 60_000,
  /** The server re-checks view access this often (and at once on an IAM cache bust). */
  accessRecheckMs: 60_000,
  /** An agent with no signal for this long leaves; "writing" lasts at most this long. */
  agentIdleMs: 120_000,
} as const;

/** WebSocket close codes. */
export const ARTIFACT_LIVE_CLOSE = {
  /** Malformed or oversized frames, or the wrong protocol version. */
  protocol: 4400,
  /** No valid ticket. */
  unauthorized: 4401,
  /** View access was lost (unshared, role change, flag off). */
  accessLost: 4403,
  /** The client sent too many frames. */
  rateLimited: 4429,
} as const;

const COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'yellow'] as const;
/** A participant's label color, as a kortix-* token name. The server derives it from the participant id. */
export type ArtifactLiveColor = (typeof COLORS)[number];

/** How the viewer shows the Artifact: a doc's Markdown, or a rendered page. */
export type ArtifactLiveView = 'doc' | 'page';

/**
 * A layout-independent point, drawn by each viewer on their own screen.
 * `doc`: the caret at `offset` code units into a short `quote` (1–64) that
 * follows `prefix` (≤ 32) in the Markdown. `page`: a point at fractions `x`, `y`
 * (0–1) of the element that `selector` (1–512) names.
 */
export type ArtifactLivePosition =
  | { kind: 'doc'; quote: string; prefix: string; offset: number }
  | { kind: 'page'; selector: string; x: number; y: number };

/** A selected range: a doc text quote (1–500) with context (≤ 32 each), or a page element's selected text. */
export type ArtifactLiveRange =
  | { kind: 'doc'; quote: string; prefix: string; suffix: string }
  | { kind: 'page'; selector: string; quote: string };

/** Where someone types: a thread's reply box, a new comment, or the doc itself. */
export type ArtifactLiveTyping = { thread_id: string } | 'new' | 'doc';

/** What a participant is doing. People are `viewing`; agents move through the other states. */
export type ArtifactLiveStatus = 'viewing' | 'reading' | 'editing' | 'writing';

/**
 * One connection (a browser tab) or one agent session. `who` names the person or
 * session, so a host shows one avatar per person while drawing one cursor per tab.
 * A `hidden` participant shows its avatar but never its cursor, selection or typing.
 */
export interface ArtifactLiveParticipant {
  id: string;
  who: { kind: 'user'; user_id: string } | { kind: 'session'; session_id: string; agent_name: string };
  name: string;
  avatar_url: string | null;
  color: ArtifactLiveColor;
  status: ArtifactLiveStatus;
  view: ArtifactLiveView | null;
  hidden: boolean;
  cursor: ArtifactLivePosition | null;
  selection: ArtifactLiveRange | null;
  typing: ArtifactLiveTyping | null;
  /** The thread this participant has open. */
  focus: string | null;
}

/** What changed: the host refetches it through REST. */
export type ArtifactLiveChange = 'comments' | 'activity' | 'content';

/** An agent names its place: reading a thread, editing near a quote, writing a reply, or idle (it leaves). */
export interface ArtifactLiveAgentSignal {
  status: 'reading' | 'editing' | 'writing' | 'idle';
  /** A thread id (UUID). */
  thread_id?: string;
  /** 1–500 characters of the Artifact's text. */
  quote?: string;
}

type Frame<T extends string, Body = unknown> = { v: 1; t: T } & Body;

/** A frame a client sends. Internal: the connection builds these. */
export type ArtifactLiveClientFrame =
  | Frame<'hello', { view: ArtifactLiveView; version: string | null; hidden?: boolean }>
  | Frame<'cursor', { at: ArtifactLivePosition | null }>
  | Frame<'selection', { range: ArtifactLiveRange | null }>
  | Frame<'typing', { where: ArtifactLiveTyping; active: boolean }>
  | Frame<'focus', { thread_id: string | null }>
  | Frame<'hide', { hidden: boolean }>
  | Frame<'ping'>
  | Frame<'bye'>;

/** A frame the server sends. Internal: the connection turns these into events. */
export type ArtifactLiveServerFrame =
  | Frame<'welcome', { you: string; sends: boolean }>
  | Frame<'presence', { participants: ArtifactLiveParticipant[] }>
  | Frame<'changed', { what: ArtifactLiveChange; version: string | null }>
  | Frame<'pong'>;

// ── Validation: the same rules as the shared zod schemas ───────────────────

type Rec = Record<string, unknown>;
type Check = (value: unknown) => boolean;

const UUID = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A string of `min`–`max` UTF-16 code units with no NUL (zod `.min`/`.max`/regex). */
const text = (max: number, min = 0): Check => (value) =>
  typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\u0000');
const fraction: Check = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const id: Check = (value) => typeof value === 'string' && UUID.test(value);
const bool: Check = (value) => typeof value === 'boolean';
const nullable = (check: Check): Check => (value) => value === null || check(value);
const oneOf = (values: readonly unknown[]): Check => (value) => values.includes(value);

/** A strict object: exactly these keys (an optional key may be absent), each passing its check. */
function strict(shape: Record<string, Check>, optional: readonly string[] = []): Check {
  return (value) => {
    if (!isRecord(value)) return false;
    for (const key of Object.keys(value)) if (!(key in shape)) return false;
    for (const [key, check] of Object.entries(shape)) {
      if (value[key] === undefined && optional.includes(key)) continue;
      if (!check(value[key])) return false;
    }
    return true;
  };
}

/** A union keyed on one field (zod `discriminatedUnion`). */
function byKind(key: string, variants: Record<string, Check>): Check {
  return (value) => {
    if (!isRecord(value)) return false;
    const tag = value[key];
    return typeof tag === 'string' && Object.prototype.hasOwnProperty.call(variants, tag) && variants[tag]!(value);
  };
}

const position = byKind('kind', {
  doc: strict({
    kind: oneOf(['doc']), quote: text(64, 1), prefix: text(32),
    offset: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 64,
  }),
  page: strict({ kind: oneOf(['page']), selector: text(512, 1), x: fraction, y: fraction }),
});

const range = byKind('kind', {
  doc: strict({ kind: oneOf(['doc']), quote: text(500, 1), prefix: text(32), suffix: text(32) }),
  page: strict({ kind: oneOf(['page']), selector: text(512, 1), quote: text(500, 1) }),
});

const typing: Check = (value) => value === 'new' || value === 'doc' || strict({ thread_id: id })(value);

const participant = strict({
  id: text(128, 1),
  who: byKind('kind', {
    user: strict({ kind: oneOf(['user']), user_id: id }),
    session: strict({ kind: oneOf(['session']), session_id: id, agent_name: text(128, 1) }),
  }),
  name: text(200, 1),
  avatar_url: nullable(text(2048)),
  color: oneOf(COLORS),
  status: oneOf(['viewing', 'reading', 'editing', 'writing']),
  view: nullable(oneOf(['doc', 'page'])),
  hidden: bool,
  cursor: nullable(position),
  selection: nullable(range),
  typing: nullable(typing),
  focus: nullable(id),
});

const frame = (t: string, body: Record<string, Check> = {}, optional: readonly string[] = []) =>
  strict({ v: oneOf([ARTIFACT_LIVE_VERSION]), t: oneOf([t]), ...body }, optional);

const serverFrame = byKind('t', {
  welcome: frame('welcome', { you: text(128, 1), sends: bool }),
  presence: frame('presence', {
    participants: (value) => Array.isArray(value) && value.length <= 200 && value.every(participant),
  }),
  changed: frame('changed', { what: oneOf(['comments', 'activity', 'content']), version: nullable(text(512)) }),
  pong: frame('pong'),
});

const clientFrame = byKind('t', {
  hello: frame('hello', { view: oneOf(['doc', 'page']), version: nullable(text(512)), hidden: bool }, ['hidden']),
  cursor: frame('cursor', { at: nullable(position) }),
  selection: frame('selection', { range: nullable(range) }),
  typing: frame('typing', { where: typing, active: bool }),
  focus: frame('focus', { thread_id: nullable(id) }),
  hide: frame('hide', { hidden: bool }),
  ping: frame('ping'),
  bye: frame('bye'),
});

/** A server frame, or null when it is not JSON or not valid. Server frames may exceed frameBytes (presence lists). */
export function parseArtifactLiveServerFrame(raw: string): ArtifactLiveServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return serverFrame(value) ? (value as ArtifactLiveServerFrame) : null;
}

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
/** UTF-8 length. Without `TextEncoder`, every code unit counts as 3 bytes: never under the real size. */
const utf8Bytes = (raw: string) => (encoder ? encoder.encode(raw).length : raw.length * 3);

/**
 * The wire text of a client frame, or null when the server would refuse it
 * (a rule broken, or over `frameBytes` in UTF-8). The server closes a socket
 * that sends a refused frame with 4400, so a refused frame is never sent.
 */
export function encodeArtifactLiveClientFrame(value: ArtifactLiveClientFrame): string | null {
  if (!clientFrame(value)) return null;
  const raw = JSON.stringify(value);
  return utf8Bytes(raw) > ARTIFACT_LIVE_LIMITS.frameBytes ? null : raw;
}
