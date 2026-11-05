import { z } from 'zod';

/**
 * The live protocol of an Artifact (KRTX-3669): presence and change pings over
 * one WebSocket per open Artifact. It carries no comment body and no Artifact
 * content: comments and content always come through REST, with its permission
 * checks. Both sides parse every frame with these schemas.
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
  /** A ticket works once, within this window. */
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

/** Label colors, as kortix-* token names. A participant's color comes from its id. Yellow is left out: it is the comment highlight. */
export const ARTIFACT_LIVE_COLORS = ['blue', 'green', 'orange', 'purple', 'red'] as const;
export type ArtifactLiveColor = (typeof ARTIFACT_LIVE_COLORS)[number];

/** The same id always gets the same color, on every client. */
export function artifactLiveColor(id: string): ArtifactLiveColor {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return ARTIFACT_LIVE_COLORS[(hash >>> 0) % ARTIFACT_LIVE_COLORS.length]!;
}

const text = (max: number) => z.string().max(max).regex(/^[^\u0000]*$/u, 'NUL is not allowed');
const fraction = z.number().finite().min(0).max(1);
const id = z.string().uuid();

/**
 * A layout-independent point, drawn by each viewer on their own screen.
 * doc: the caret at `offset` code units into a short `quote` that follows `prefix` in the Markdown.
 * page: a point at fractions `x`, `y` of the element that `selector` names (geometry only).
 */
export const artifactLivePositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('doc'), quote: text(64).min(1), prefix: text(32), offset: z.number().int().min(0).max(64) }).strict(),
  z.object({ kind: z.literal('page'), selector: text(512).min(1), x: fraction, y: fraction }).strict(),
]);
export type ArtifactLivePosition = z.infer<typeof artifactLivePositionSchema>;

/** A selected range: a doc text quote with context, or a page element's selected text. */
export const artifactLiveRangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('doc'), quote: text(500).min(1), prefix: text(32), suffix: text(32) }).strict(),
  z.object({ kind: z.literal('page'), selector: text(512).min(1), quote: text(500).min(1) }).strict(),
]);
export type ArtifactLiveRange = z.infer<typeof artifactLiveRangeSchema>;

/** Where someone types: a thread's reply box, a new comment, or the doc itself. */
export const artifactLiveTypingSchema = z.union([z.object({ thread_id: id }).strict(), z.literal('new'), z.literal('doc')]);
export type ArtifactLiveTyping = z.infer<typeof artifactLiveTypingSchema>;

const frame = { v: z.literal(ARTIFACT_LIVE_VERSION) };

export const artifactLiveClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ ...frame, t: z.literal('hello'), view: z.enum(['doc', 'page']), version: text(512).nullable(), hidden: z.boolean().optional() }).strict(),
  z.object({ ...frame, t: z.literal('cursor'), at: artifactLivePositionSchema.nullable() }).strict(),
  z.object({ ...frame, t: z.literal('selection'), range: artifactLiveRangeSchema.nullable() }).strict(),
  z.object({ ...frame, t: z.literal('typing'), where: artifactLiveTypingSchema, active: z.boolean() }).strict(),
  z.object({ ...frame, t: z.literal('focus'), thread_id: id.nullable() }).strict(),
  z.object({ ...frame, t: z.literal('hide'), hidden: z.boolean() }).strict(),
  z.object({ ...frame, t: z.literal('ping') }).strict(),
  z.object({ ...frame, t: z.literal('bye') }).strict(),
]);
export type ArtifactLiveClientFrame = z.infer<typeof artifactLiveClientFrameSchema>;

/** What a participant is doing. People are `viewing`; agents move through the other states. */
export const artifactLiveStatusSchema = z.enum(['viewing', 'reading', 'editing', 'writing']);
export type ArtifactLiveStatus = z.infer<typeof artifactLiveStatusSchema>;

/**
 * One connection (a browser tab) or one agent session. `who` names the person or
 * session, so a client can show one avatar per person while drawing one cursor per tab.
 * A `hidden` participant shows its avatar but never its cursor, selection, typing or focus.
 */
export const artifactLiveParticipantSchema = z.object({
  id: text(128).min(1),
  who: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), user_id: id }).strict(),
    z.object({ kind: z.literal('session'), session_id: id, agent_name: text(128).min(1) }).strict(),
  ]),
  name: text(200).min(1),
  avatar_url: text(2048).nullable(),
  color: z.enum(ARTIFACT_LIVE_COLORS),
  status: artifactLiveStatusSchema,
  view: z.enum(['doc', 'page']).nullable(),
  hidden: z.boolean(),
  cursor: artifactLivePositionSchema.nullable(),
  selection: artifactLiveRangeSchema.nullable(),
  typing: artifactLiveTypingSchema.nullable(),
  focus: id.nullable(),
}).strict();
export type ArtifactLiveParticipant = z.infer<typeof artifactLiveParticipantSchema>;

/** What changed: the client refetches it through REST. */
export const artifactLiveChangeSchema = z.enum(['comments', 'activity', 'content', 'doc']);
export type ArtifactLiveChange = z.infer<typeof artifactLiveChangeSchema>;

export const artifactLiveServerFrameSchema = z.discriminatedUnion('t', [
  z.object({ ...frame, t: z.literal('welcome'), you: text(128).min(1), sends: z.boolean() }).strict(),
  z.object({ ...frame, t: z.literal('presence'), participants: z.array(artifactLiveParticipantSchema).max(200) }).strict(),
  z.object({ ...frame, t: z.literal('changed'), what: artifactLiveChangeSchema, version: text(512).nullable() }).strict(),
  z.object({ ...frame, t: z.literal('pong') }).strict(),
]);
export type ArtifactLiveServerFrame = z.infer<typeof artifactLiveServerFrameSchema>;

/**
 * An agent names its place (`kortix artifacts focus`, session token): reading a thread,
 * editing near a quote, writing a reply, or idle (it leaves).
 */
export const artifactLiveAgentSignalSchema = z.object({
  status: z.enum(['reading', 'editing', 'writing', 'idle']),
  thread_id: id.optional(),
  quote: text(500).min(1).optional(),
}).strict();
export type ArtifactLiveAgentSignal = z.infer<typeof artifactLiveAgentSignalSchema>;

function decode(raw: string | ArrayBuffer | Uint8Array): unknown {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw).length : raw.byteLength;
  if (bytes > ARTIFACT_LIVE_LIMITS.frameBytes) return undefined;
  const textValue = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  try {
    return JSON.parse(textValue);
  } catch {
    return undefined;
  }
}

/** A client frame, or null when it is oversized, not JSON, or not valid. */
export function parseArtifactLiveClientFrame(raw: string | ArrayBuffer | Uint8Array): ArtifactLiveClientFrame | null {
  const value = decode(raw);
  const parsed = value === undefined ? null : artifactLiveClientFrameSchema.safeParse(value);
  return parsed?.success ? parsed.data : null;
}

/** A server frame, or null when it is not valid. Server frames may exceed frameBytes (presence lists). */
export function parseArtifactLiveServerFrame(raw: string): ArtifactLiveServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = artifactLiveServerFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
