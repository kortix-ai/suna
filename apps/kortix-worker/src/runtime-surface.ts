import { serveGlobalEventStream } from './global-event-stream.ts';
/**
 * The Kortix Runtime API, pi-worker half — `/kortix/opencode/*` served by the
 * WORKER so the product's session surface renders a pi session unchanged.
 *
 * The web client speaks ONLY this namespace since #6987: one `/state`
 * projection, a paged `/messages/:sessionId` transcript, and ONE sequenced
 * `/events` SSE that the API attaches to and relays. The daemon documents the
 * namespace as "the runtime OpenCode manages" with a future harness getting
 * `/kortix/<harness>/*`; the client is not namespace-parameterized yet, so the
 * worker serves the SAME five-shape contract verbatim — the bodies are
 * OpenCode wire shapes, which is exactly what the S0.5 adapter emits. When the
 * SDK grows engine-aware namespacing this mounts at `/kortix/pi/*` too and the
 * alias retires.
 *
 * Everything here mirrors the daemon implementation deliberately
 * (apps/kortix-sandbox-agent-server: kortix-event-bus.ts, opencode-runtime.ts,
 * runtime-state-projection.ts) — same seq/epoch semantics, same hello/resync/
 * heartbeat framing, same auth posture (Bearer KORTIX_TOKEN for service calls,
 * HMAC X-Kortix-User-Context — header or `__kortix_user_context` query — for
 * user calls). Copied, not imported: the worker is standalone by design.
 *
 * ONE SOURCE OF TRUTH for list AND stream: every wire event the adapter emits
 * is (a) sequenced onto the bus and (b) applied to the transcript store, so
 * `/messages` always says exactly what `/events` said and ids can never
 * disagree between the two.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Agent, Session, ToolList } from '@opencode-ai/sdk/v2';
import { assistantContractFields, assistantMessageError, toolResultMetadata } from './chat-events.ts';
import type { PiCommand } from './command-runtime.ts';
import { PermissionApprovalUnavailableError, type PermissionBroker } from './permission-broker.ts';
import { type PermissionConfig, type PermissionRule, compilePermissionRules } from './permission-policy.ts';
import type { QuestionBroker } from './question-broker.ts';
import type { PiTodo } from './todo-tools.ts';
import { type PiSkill, projectSkillInfo } from './skill-runtime.ts';
import {
  WIRE_ID_TIME_MASK,
  WIRE_ID_TIME_SCALE,
  WIRE_MESSAGE_ID,
  mintWireMessageId,
  wireIdTime,
} from './wire-message-id';

// ---------------------------------------------------------------------------
// Auth — the daemon's user-context codec, verify side.
// ---------------------------------------------------------------------------

export const KORTIX_USER_CONTEXT_HEADER = 'x-kortix-user-context';
export const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context';

export function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function base64urlDecode(s: string): Buffer {
  const pad = 4 - (s.length % 4);
  const padded = pad < 4 ? s + '='.repeat(pad) : s;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function verifyUserContext(token: string | undefined | null, secret: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expected = base64urlEncode(createHmac('sha256', secret).update(parts[0]).digest());
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(base64urlDecode(parts[0]).toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event bus — the daemon's seq/epoch/ring semantics, compact.
// ---------------------------------------------------------------------------

export const RING_CAPACITY = 2_000;
export const EVENT_HEARTBEAT_MS = 15_000;

export interface WireEvent {
  seq: number;
  type: string;
  at: number;
  payload: unknown;
  session?: string;
}

interface Resync {
  reason: 'epoch-changed' | 'gap-too-old' | 'ahead-of-head';
  epoch: string;
  first_seq: number;
  head_seq: number;
  requested_since: number | null;
  recover: string[];
}

const RECOVER_RECIPE = ['GET /kortix/opencode/state', 'GET /kortix/opencode/messages/:sessionId'];

export class WorkerEventBus {
  private seq = 0;
  private ring: WireEvent[] = [];
  private readonly listeners = new Set<(e: WireEvent) => void>();
  readonly epoch = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  get headSeq(): number {
    return this.seq;
  }
  get firstSeq(): number {
    return this.ring.length > 0 ? this.ring[0]!.seq : this.seq;
  }

  publish(type: string, payload: unknown, session?: string): WireEvent {
    const event: WireEvent = {
      seq: ++this.seq,
      type,
      at: Date.now(),
      payload,
      ...(session ? { session } : {}),
    };
    this.ring.push(event);
    if (this.ring.length > RING_CAPACITY) this.ring.splice(0, this.ring.length - RING_CAPACITY);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // one broken consumer must never stop the stream for the others
      }
    }
    return event;
  }

  subscribe(
    listener: (e: WireEvent) => void,
    opts: { since: number | null; epoch: string | null },
  ): { replay: WireEvent[]; resync: Resync | null; unsubscribe: () => void } {
    // Snapshot + attach in one synchronous tick — the atomic handoff the
    // daemon's bus documents. Nothing can publish between these lines.
    let replay: WireEvent[] = [];
    let resync: Resync | null = null;
    if (opts.since !== null) {
      const mkResync = (reason: Resync['reason']): Resync => ({
        reason,
        epoch: this.epoch,
        first_seq: this.firstSeq,
        head_seq: this.headSeq,
        requested_since: opts.since,
        recover: RECOVER_RECIPE,
      });
      if (opts.epoch && opts.epoch !== this.epoch) resync = mkResync('epoch-changed');
      else if (opts.since > this.headSeq) resync = mkResync('ahead-of-head');
      else if (
        opts.since < this.firstSeq - 1 &&
        this.ring.length > 0 &&
        opts.since < this.ring[0]!.seq - 1
      )
        resync = mkResync('gap-too-old');
      else replay = this.ring.filter((e) => e.seq > (opts.since as number));
    }
    this.listeners.add(listener);
    return {
      replay,
      resync,
      unsubscribe: () => this.listeners.delete(listener),
    };
  }
}

// ---------------------------------------------------------------------------
// Transcript store — /messages serves exactly what /events said.
// ---------------------------------------------------------------------------

interface StoredMessage {
  info: Record<string, unknown> & { id: string };
  parts: Map<string, Record<string, unknown>>;
  order: string[];
}

export class WireTranscript {
  private readonly messages = new Map<string, StoredMessage>();
  private order: string[] = [];
  /**
   * Ids hidden by a rewind, still held in `messages`.
   *
   * Staged, not deleted: `rewind()` promises a reversible rollback, so the
   * bytes have to survive until either `unrevert()` puts them back or the next
   * prompt commits the new path. Keeping them out of `order` is what makes
   * `page()` — and therefore `/messages` — agree with the removal events
   * already on the wire, with no second code path.
   */
  private staged: string[] = [];

  apply(wire: { type: string; properties: Record<string, unknown> }): void {
    if (wire.type === 'message.updated') {
      const info = wire.properties.info as (Record<string, unknown> & { id?: string }) | undefined;
      if (!info?.id) return;
      const existing = this.messages.get(info.id);
      if (existing) {
        existing.info = { ...existing.info, ...info, id: info.id };
      } else {
        this.messages.set(info.id, { info: { ...info, id: info.id }, parts: new Map(), order: [] });
        this.order.push(info.id);
        this.order.sort();
      }
      return;
    }
    if (wire.type === 'message.part.updated') {
      const part = wire.properties.part as
        | (Record<string, unknown> & { id?: string; messageID?: string })
        | undefined;
      if (!part?.id || !part.messageID) return;
      let message = this.messages.get(part.messageID);
      if (!message) {
        // A part can outrun its message frame on a hot stream — hold the slot.
        message = {
          info: { id: part.messageID, role: 'assistant', sessionID: part.sessionID },
          parts: new Map(),
          order: [],
        } as StoredMessage;
        this.messages.set(part.messageID, message);
        this.order.push(part.messageID);
        this.order.sort();
      }
      if (!message.parts.has(part.id)) message.order.push(part.id);
      message.parts.set(part.id, part);
      return;
    }
    // A reconnecting client replays the wire, so `/messages` can only agree
    // with `/events` if removals are replayable too.
    if (wire.type === 'message.removed') {
      const id = wire.properties.messageID as string | undefined;
      if (!id) return;
      this.messages.delete(id);
      this.order = this.order.filter((x) => x !== id);
      this.staged = this.staged.filter((x) => x !== id);
      return;
    }
    if (wire.type === 'message.part.removed') {
      const id = wire.properties.messageID as string | undefined;
      const partId = wire.properties.partID as string | undefined;
      if (!id || !partId) return;
      const message = this.messages.get(id);
      if (!message) return;
      message.parts.delete(partId);
      message.order = message.order.filter((x) => x !== partId);
    }
  }

  /**
   * Hide `fromId` and everything after it. Returns the ids removed, oldest
   * first, so the caller can emit one `message.removed` per id.
   *
   * An unknown id removes nothing rather than guessing a position — a rewind
   * that silently truncated at the wrong place would be worse than one that
   * did nothing.
   */
  revert(fromId: string): string[] {
    if (!this.messages.has(fromId)) return [];
    const cut = this.order.filter((id) => id >= fromId);
    if (cut.length === 0) return [];
    this.order = this.order.filter((id) => id < fromId);
    // A second, earlier rewind subsumes the first: everything stays staged and
    // one restore brings the whole tail back in id order.
    this.staged = [...this.staged, ...cut].sort();
    return cut;
  }

  /** Put every staged message back. Returns the ids restored, oldest first. */
  unrevert(): string[] {
    if (this.staged.length === 0) return [];
    const restored = [...this.staged].sort();
    this.order = [...this.order, ...restored].sort();
    this.staged = [];
    return restored;
  }

  /**
   * Drop the staged tail for good — the next prompt has committed the new path.
   * After this `unrevert()` cannot resurrect it, which is the point: splicing a
   * dead branch into a conversation that has moved on is worse than losing it.
   */
  commitRevert(): string[] {
    if (this.staged.length === 0) return [];
    const dropped = [...this.staged].sort();
    for (const id of dropped) this.messages.delete(id);
    this.staged = [];
    return dropped;
  }

  /** Ids currently hidden by a rewind. */
  get stagedIds(): string[] {
    return [...this.staged];
  }

  /** One message with its parts in order, or null. Used to re-announce a restore. */
  messageById(
    id: string,
  ): { info: Record<string, unknown>; parts: Record<string, unknown>[] } | null {
    const m = this.messages.get(id);
    if (!m) return null;
    return { info: m.info, parts: m.order.map((pid) => m.parts.get(pid)!).filter(Boolean) };
  }

  page(opts: { limit: number; before: string | null }): {
    messages: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>;
    hasMore: boolean;
  } {
    const eligible = opts.before
      ? this.order.filter((id) => id < (opts.before as string))
      : this.order;
    const window = eligible.slice(-opts.limit);
    return {
      messages: window.map((id) => {
        const m = this.messages.get(id)!;
        return { info: m.info, parts: m.order.map((pid) => m.parts.get(pid)!) };
      }),
      hasMore: eligible.length > window.length,
    };
  }

  get count(): number {
    return this.order.length;
  }

  clear(): void {
    this.messages.clear();
    this.order = [];
    this.staged = [];
  }
}

// ---------------------------------------------------------------------------
// The surface.
// ---------------------------------------------------------------------------

/** Deterministic, opencode-shaped, never a project-session UUID. */
export function mintRootId(sessionId: string): string {
  const digest = createHash('sha256').update(`pi-root\0${sessionId}`).digest('hex');
  return `ses_pi${digest.slice(0, 24)}`;
}

export const DEFAULT_MESSAGE_PAGE = 20;
export const MAX_MESSAGE_PAGE = 200;

interface RawMessageCursor {
  id: string;
  time: number;
}

function encodeRawMessageCursor(cursor: RawMessageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeRawMessageCursor(value: string): RawMessageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      id?: unknown;
      time?: unknown;
    };
    if (
      typeof parsed.id !== 'string' ||
      !parsed.id.startsWith('msg_') ||
      typeof parsed.time !== 'number' ||
      !Number.isFinite(parsed.time) ||
      parsed.time < 0
    ) {
      return null;
    }
    return { id: parsed.id, time: parsed.time };
  } catch {
    return null;
  }
}

class RawBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
  }
}

function readRawJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += next.byteLength;
      if (bytes > maxBytes) {
        req.resume?.();
        finish(() => reject(new RawBodyError(`request body exceeds ${maxBytes} bytes`, 413)));
        return;
      }
      chunks.push(next);
    };
    const onEnd = () =>
      finish(() => {
        try {
          const text = Buffer.concat(chunks, bytes).toString('utf8');
          resolve(text ? JSON.parse(text) : {});
        } catch {
          reject(new RawBodyError('request body must be valid JSON', 400));
        }
      });
    const onError = (error: Error) => finish(() => reject(error));
    const onAborted = () => finish(() => reject(new Error('request body was aborted')));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume?.();
      finish(() => reject(new RawBodyError(`request body exceeds ${maxBytes} bytes`, 413)));
    }
  });
}

export interface RuntimeSurfaceOptions {
  todos?: () => PiTodo[];
  sessionId: string;
  projectId?: string;
  /** The worker's own KORTIX_TOKEN — service bearer AND user-context secret. */
  token?: string;
  agentName?: string;
  agentConfigEtag?: string | null;
  commandConfigEtag?: string | null;
  skillConfigEtag?: string | null;
  agents?: Record<
    string,
    {
      description?: string;
      mode?: 'primary' | 'subagent' | 'all';
      model?: string;
      variant?: string;
      temperature?: number;
      top_p?: number;
      prompt?: string;
      disable?: boolean;
      hidden?: boolean;
      options?: Record<string, unknown>;
      color?: string;
      steps?: number;
      permission?: PermissionConfig;
    }
  >;
  commands?: PiCommand[];
  skills?: PiSkill[];
  tools?: readonly AgentTool[];
  defaultModel?: string | null;
  resolvedModel?: { providerID: string; modelID: string };
  workspace?: string;
  permissions?: PermissionBroker;
  permissionConfig?: PermissionConfig;
  sessionPermission?: () => PermissionRule[];
  /** Pending user questions created by Pi's `question` tool. */
  questions?: QuestionBroker;
  /**
   * Stop the run in flight. Wired to `Agent.abort()` by the worker.
   *
   * Without it, the client's Stop (`session.abort` -> POST
   * `session/:id/abort`) fell through to this surface's catch-all 404: the UI
   * showed "Interrupted" from its own optimistic receipt while the agent kept
   * generating (reported 2026-08-29, pi). Optional so the bench, which builds
   * a surface with no agent, keeps working.
   */
  onAbort?: () => void | Promise<void>;
  /** Read the durable session status when requests can reach any worker. */
  onStatus?: () => { type: string } | Promise<{ type: string }>;
  /**
   * Remove an admitted prompt before it starts running.
   *
   * The worker owns queue durability, so the HTTP compatibility surface must
   * ask it before deleting transcript state. A running prompt is immutable:
   * callers must abort it instead of making its accepted input disappear.
   */
  onDeleteMessage?: (
    messageId: string,
  ) => 'deleted' | 'running' | 'missing' | Promise<'deleted' | 'running' | 'missing'>;
}

interface RestoredTranscriptMessage {
  details?: unknown;
  role?: string;
  content?: unknown;
  timestamp?: number | string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  model?: string;
  provider?: string;
  usage?: unknown;
  stopReason?: string;
  errorMessage?: string;
  kortixWireMessageId?: string;
  kortixParentMessageId?: string;
}

interface RestoredWireMessage {
  info: Record<string, unknown> & { id: string };
  parts: Array<Record<string, unknown>>;
}

function agentModel(ref: string | undefined): { providerID: string; modelID: string } | null {
  if (!ref || !ref.includes('/')) return null;
  const native = ref.startsWith('kortix/') ? ref.slice('kortix/'.length) : ref;
  const slash = native.indexOf('/');
  return { providerID: native.slice(0, slash), modelID: native.slice(slash + 1) };
}

function workspaceQueryMatches(url: URL, workspace: string): boolean {
  return [...url.searchParams.getAll('directory'), ...url.searchParams.getAll('workspace')].every(
    (candidate) => candidate === workspace,
  );
}

export class RuntimeSurface {
  readonly rootId: string;
  readonly bus = new WorkerEventBus();
  readonly transcript = new WireTranscript();
  private status: { type: string } = { type: 'idle' };
  /** The user message id of the turn currently running, for the health turn
   *  probe the API's turn-lifecycle polls (`/kortix/health?turn=1`). */
  private activeTurnMessageId: string | null = null;
  private turnInFlight = false;
  private messageSeq = 0;
  /** Clock of the last id this surface minted — see . */
  private lastMintedTime: bigint | null = null;
  /** Complete durable transcript ordering key, including the random tail. */
  private lastObservedMessageId: string | null = null;
  private readonly createdAt = Date.now();
  private updatedAt = Date.now();
  private title: string;

  constructor(private readonly opts: RuntimeSurfaceOptions) {
    this.rootId = mintRootId(opts.sessionId);
    this.title = opts.agentName ? `${opts.agentName} session` : 'Pi session';
  }

  /**
   * The id IS the transcript's sort key, so it has to be a real OpenCode wire
   * id — `msg_` + 12 hex clock chars + 14 base62.
   *
   * This used to mint `msg_pi00000001`, zero-padded "so message ids sort in
   * mint order". They did sort in mint order among THEMSELVES, and that was
   * the whole bug: the web client splits messages on `/^msg_[0-9a-f]{12}/`
   * into "the server placed this" and "only this tab knows about it", and
   * sorts every local one after every placed one. `p` and `i` are not hex,
   * so every reply this worker produced sorted below the entire transcript and
   * `groupMessagesIntoTurns` attached them all to the LAST user message —
   * three questions rendered as three bubbles followed by three answers.
   *
   * Seeded from the turn's own user message id, so a reply cannot sort above
   * the question it answers however far this box's clock has drifted, and from
   * the previous mint, so two replies inside one millisecond still order.
   */
  mintMessageId = (): string => {
    this.messageSeq++;
    const parentTime = wireIdTime(this.activeTurnMessageId);
    const floor =
      this.lastMintedTime === null
        ? parentTime
        : parentTime === null || this.lastMintedTime > parentTime
          ? this.lastMintedTime
          : parentTime;
    const minted = mintWireMessageId({ nowMs: Date.now(), newestKnownTime: floor });
    this.observeMessageId(minted.id);
    return minted.id;
  };

  /**
   * Rebuild the transcript from the durable log after a restart (P1.8).
   *
   * One pi instance IS one session, so a box that comes back must come back
   * with the SAME conversation — otherwise the session answers with no memory
   * of what was said, and `/messages` reports an empty history for a session
   * the store knows is three turns deep.
   *
   * Persisted messages retain their wire ids and parent links. Legacy entries
   * without ids receive deterministic ids, so repeated restoration is stable.
   * Seed before a live turn to advance the mint clock beyond durable history.
   *
   * Applied straight to the transcript, not through `publishWire`: history is
   * not news. Replaying it onto the bus would hand a reconnecting client a
   * burst of "new" events for messages it already has.
   */
  seedRestoredMessages(messages: RestoredTranscriptMessage[]): number {
    let seeded = 0;
    let lastUserId: string | null = null;
    const fallbackModel = this.opts.resolvedModel ??
      agentModel(this.opts.defaultModel ?? undefined) ?? {
        providerID: 'unknown',
        modelID: 'unknown',
      };
    const agent = this.opts.agentName ?? 'build';
    // A tool call and its result are TWO durable messages (the assistant's
    // `toolCall` block, then a `role: 'toolResult'` message pointing back at it
    // by `toolCallId`). The live wire shape is one `tool` part that moves from
    // running to completed, so the result has to fold onto the part the call
    // created rather than become a bubble of its own — otherwise a resumed
    // session shows "Successfully wrote 4 bytes to number.txt" as something
    // the assistant SAID, and the write card it belongs to is missing.
    const toolParts = new Map<
      string,
      { messageId: string; partId: string; tool: string; input: unknown; startedAt: number }
    >();
    let restoredClock: bigint | null = null;

    for (const [messageIndex, message] of messages.entries()) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const parsedTimestamp =
        typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN;
      const created =
        typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
          ? message.timestamp
          : Number.isFinite(parsedTimestamp)
            ? parsedTimestamp
            : messageIndex;

      if (message.role === 'toolResult') {
        const pending = message.toolCallId ? toolParts.get(message.toolCallId) : undefined;
        // An orphan result (its call fell outside the restored window) has no
        // part to update. Dropping it is right: on its own it is a bare string
        // with nothing to attach it to.
        if (!pending) continue;
        const output = blocks
          .filter((b: any) => b && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('');
        this.applyToolPart(pending, {
          ...(message.isError
            ? { status: 'error', error: output }
            : { status: 'completed', output, title: pending.tool, metadata: toolResultMetadata(message.details) }),
          input: pending.input,
          time: { start: pending.startedAt, end: created },
        });
        continue;
      }

      const role = message.role === 'user' ? 'user' : 'assistant';
      const parts: Array<
        | { kind: 'text'; text: string }
        | { kind: 'reasoning'; text: string }
        | { kind: 'tool'; call: any }
      > = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as {
          type?: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          arguments?: unknown;
        };
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0)
          parts.push({ kind: 'reasoning', text: b.thinking });
        else if (typeof b.text === 'string' && b.text.length > 0)
          parts.push({ kind: 'text', text: b.text });
        else if (b.type === 'toolCall' && b.name) parts.push({ kind: 'tool', call: b });
      }
      // A message with nothing renderable would show as an empty bubble.
      // Keep a terminal assistant envelope even when the provider returned no
      // content. Its parent and error are the durable turn identity used by
      // boot reconciliation; dropping it changes an exact provider failure
      // into an unidentified generic idle state after restart.
      const terminalAssistant =
        role === 'assistant' &&
        (message.stopReason === 'stop' ||
          message.stopReason === 'length' ||
          message.stopReason === 'error' ||
          message.stopReason === 'aborted');
      if (parts.length === 0 && !terminalAssistant) continue;

      let id = message.kortixWireMessageId;
      if (id) {
        const encoded = wireIdTime(id);
        if (encoded !== null && (restoredClock === null || encoded > restoredClock)) {
          restoredClock = encoded;
        }
      } else {
        const rawClock =
          (BigInt(Math.max(0, Math.trunc(created))) * WIRE_ID_TIME_SCALE) & WIRE_ID_TIME_MASK;
        const encoded: bigint =
          restoredClock !== null && rawClock <= restoredClock
            ? restoredClock + BigInt(1)
            : rawClock;
        if (encoded > WIRE_ID_TIME_MASK) {
          throw new Error('restored wire message id ordering clock is exhausted');
        }
        const tail = createHash('sha256')
          .update(JSON.stringify([messageIndex, message]))
          .digest('hex')
          .slice(0, 14);
        id = `msg_${encoded.toString(16).padStart(12, '0')}${tail}`;
        restoredClock = encoded;
      }
      this.observeMessageId(id);

      if (role === 'assistant' && !message.kortixParentMessageId && !lastUserId) {
        // An assistant without a user parent cannot satisfy the OpenCode v2
        // message contract. The full active branch normally starts with a user;
        // fail closed for corrupt or truncated legacy data instead of inventing
        // a relationship.
        continue;
      }

      const resolvedModel =
        this.opts.resolvedModel ??
        ({
          providerID: message.provider ?? fallbackModel.providerID,
          modelID: message.model ?? fallbackModel.modelID,
        } as const);
      const info =
        role === 'user'
          ? {
              id,
              role,
              sessionID: this.rootId,
              time: { created },
              agent,
              model: resolvedModel,
            }
          : {
              id,
              role,
              sessionID: this.rootId,
              parentID: message.kortixParentMessageId ?? lastUserId!,
              time: { created, completed: created },
              modelID: resolvedModel.modelID,
              providerID: resolvedModel.providerID,
              ...assistantContractFields(message.usage, {
                agent,
                mode: agent,
                workspace: this.opts.workspace,
              }),
              ...(assistantMessageError(message) ? { error: assistantMessageError(message) } : {}),
            };

      this.transcript.apply({
        type: 'message.updated',
        properties: {
          sessionID: this.rootId,
          info,
        },
      });
      if (role === 'user') lastUserId = id;
      parts.forEach((part, index) => {
        const partId = `${id}-p${index}`;
        if (part.kind === 'text' || part.kind === 'reasoning') {
          this.transcript.apply({
            type: 'message.part.updated',
            properties: {
              sessionID: this.rootId,
              part: {
                id: partId,
                messageID: id,
                sessionID: this.rootId,
                type: part.kind === 'text' ? 'text' : 'reasoning',
                text: part.text,
                ...(part.kind === 'reasoning' ? { time: { start: created, end: created } } : {}),
              },
            },
          });
          return;
        }
        const entry = {
          messageId: id,
          partId,
          tool: String(part.call.name),
          input: part.call.arguments,
          startedAt: created,
        };
        // Left 'running' on purpose when no result follows: that is exactly
        // what an interrupted turn was, and claiming it completed would be a lie.
        this.applyToolPart(entry, {
          status: 'running',
          input: entry.input,
          time: { start: created },
        });
        if (typeof part.call.id === 'string') toolParts.set(part.call.id, entry);
      });
      seeded++;
    }
    return seeded;
  }

  /** Advance the mint clock past an externally supplied or restored wire id. */
  observeMessageId(id: string): void {
    const time = wireIdTime(id);
    if (time !== null && (this.lastMintedTime === null || time > this.lastMintedTime)) {
      this.lastMintedTime = time;
    }
    if (
      WIRE_MESSAGE_ID.test(id) &&
      (this.lastObservedMessageId === null || id > this.lastObservedMessageId)
    ) {
      this.lastObservedMessageId = id;
    }
  }

  /**
   * New caller-supplied ids must advance the durable transcript clock.
   * Exact retries are resolved from the turn journal before this check.
   */
  canAdmitMessageId(id: string): boolean {
    return (
      WIRE_MESSAGE_ID.test(id) &&
      (this.lastObservedMessageId === null || id > this.lastObservedMessageId)
    );
  }

  /**
   * Restore exact OpenCode wire envelopes without announcing old data as new.
   * Used for accepted queue entries that reached the durable admission log but
   * had not yet entered Pi's own message tree when the worker stopped.
   */
  seedWireMessages(messages: RestoredWireMessage[]): number {
    for (const message of messages) {
      this.observeMessageId(message.info.id);
      this.transcript.apply({
        type: 'message.updated',
        properties: { sessionID: this.rootId, info: message.info },
      });
      for (const part of message.parts) {
        this.transcript.apply({
          type: 'message.part.updated',
          properties: { sessionID: this.rootId, part },
        });
      }
    }
    return messages.length;
  }

  replaceDurableMessages(
    restoredMessages: RestoredTranscriptMessage[],
    wireMessages: RestoredWireMessage[],
  ): number {
    const previous = structuredClone(
      this.transcript.page({ limit: Math.max(this.transcript.count, 1), before: null }).messages,
    );
    const previousById = new Map(previous.map((message) => [message.info.id, message]));

    this.transcript.clear();
    const restored = this.seedRestoredMessages(restoredMessages);
    this.seedWireMessages(wireMessages);

    const next = structuredClone(
      this.transcript.page({ limit: Math.max(this.transcript.count, 1), before: null }).messages,
    );
    const nextById = new Map(next.map((message) => [message.info.id, message]));
    for (const message of previous) {
      const replacement = nextById.get(message.info.id);
      if (replacement && isDeepStrictEqual(message, replacement)) continue;
      this.publishWire({
        type: 'message.removed',
        properties: { messageID: message.info.id, sessionID: this.rootId },
        busOnly: true,
      });
    }
    for (const message of next) {
      const existing = previousById.get(message.info.id);
      if (existing && isDeepStrictEqual(existing, message)) continue;
      this.publishWire({
        type: 'message.updated',
        properties: { sessionID: this.rootId, info: message.info },
        busOnly: true,
      });
      for (const part of message.parts) {
        this.publishWire({
          type: 'message.part.updated',
          properties: { sessionID: this.rootId, part },
          busOnly: true,
        });
      }
    }
    return restored;
  }

  /** Completed assistant wire messages that belong to one accepted user turn. */
  assistantMessagesForParent(
    parentId: string,
  ): Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }> {
    return this.transcript
      .page({ limit: Math.max(this.transcript.count, 1), before: null })
      .messages.filter(
        (message) => message.info.role === 'assistant' && message.info.parentID === parentId,
      );
  }

  /** One `tool` part, in the same shape the live adapter emits (chat-events.ts). */
  private applyToolPart(
    entry: { messageId: string; partId: string; tool: string },
    state: Record<string, unknown>,
  ): void {
    this.transcript.apply({
      type: 'message.part.updated',
      properties: {
        sessionID: this.rootId,
        part: {
          id: entry.partId,
          messageID: entry.messageId,
          sessionID: this.rootId,
          type: 'tool',
          tool: entry.tool,
          callID: entry.partId,
          state,
        },
      },
    });
  }

  /** Sequence one adapter wire event AND fold it into the transcript. */
  publishWire(wire: {
    type: string;
    properties: Record<string, unknown>;
    transcriptOnly?: boolean;
    /**
     * Bus only — do NOT apply to the transcript. The mirror of
     * `transcriptOnly`, and rewind is why it exists: the transcript has
     * already STAGED the change, and re-applying a `message.removed` through
     * `apply()` would delete the staged copy for good, so `unrevert()` would
     * find nothing to restore and a "reversible" rollback would be permanent.
     */
    busOnly?: boolean;
  }): void {
    this.updatedAt = Date.now();
    // A transcript-only frame is the full-text twin of a `message.part.delta`:
    // the transcript stores the whole string, the bus carries the append. Put
    // both on the bus and a subscriber applies the text twice.
    if (wire.transcriptOnly) {
      this.transcript.apply(wire);
      return;
    }
    if (wire.type === 'session.status') {
      const status = wire.properties.status as { type?: string } | undefined;
      if (status?.type) this.status = { type: status.type };
    }
    if (!wire.busOnly) this.transcript.apply(wire);
    const session =
      (wire.properties.sessionID as string | undefined) ??
      (wire.properties.info as { sessionID?: string } | undefined)?.sessionID ??
      (wire.properties.part as { sessionID?: string } | undefined)?.sessionID;
    this.bus.publish(wire.type, wire.properties, session);
  }

  /** Record turn start/end so the health turn probe can report it. */
  markTurn(userMessageId: string | null, inFlight: boolean): void {
    this.turnInFlight = inFlight;
    this.activeTurnMessageId = inFlight ? userMessageId : null;
  }

  /**
   * Who the ending turn IS, for `POST /turn-stream`.
   *
   * `completeSandboxTurn` (apps/api) does not close "the open turn" — it
   * SELECTS one by identity, and both fields are load-bearing:
   *   • a candidate is only considered when its stored `opencodeSessionId` is
   *     null OR equals the one reported, and every pi turn stores `ses_pi…`,
   *     so omitting it makes the candidate set empty;
   *   • the matched row must then equal the reported `messageId`, because the
   *     no-id fallback branch only matches turns whose own `messageId` is null.
   * Relaying without these returns HTTP 200 having closed NOTHING, which the
   * relay reads as success — the failure mode this method exists to prevent.
   *
   * Read SYNCHRONOUSLY at `agent_end`: the id is cleared by `markTurn(_, false)`
   * in `runTurn`'s `finally`, which runs once `agent.prompt()` resolves.
   */
  turnEndIdentity(): { opencodeSessionId: string; messageId: string | null } {
    return { opencodeSessionId: this.rootId, messageId: this.activeTurnMessageId };
  }

  completedTurnIdentities(): Array<{
    opencodeSessionId: string;
    messageId: string;
    status: 'idle' | 'error';
  }> {
    const messages = this.transcript.page({
      limit: Math.max(this.transcript.count, 1),
      before: null,
    }).messages;
    const byParent = new Map<
      string,
      { opencodeSessionId: string; messageId: string; status: 'idle' | 'error' }
    >();
    for (const message of messages) {
      const info = message.info as
        | { role?: unknown; parentID?: unknown; error?: unknown }
        | undefined;
      if (info?.role !== 'assistant' || typeof info.parentID !== 'string' || !info.parentID)
        continue;
      byParent.set(info.parentID, {
        opencodeSessionId: this.rootId,
        messageId: info.parentID,
        status: info.error ? 'error' : 'idle',
      });
    }
    return [...byParent.values()];
  }

  latestCompletedTurnIdentity(): {
    opencodeSessionId: string;
    messageId: string;
    status: 'idle' | 'error';
  } | null {
    return this.completedTurnIdentities().at(-1) ?? null;
  }

  /**
   * The turn-probe answer for `GET /kortix/health?turn=1&turn_message_id=…`.
   * The API's turn-lifecycle polls this to renew the box's deadline while a
   * turn runs and to settle it when the turn ends — without it the reaper can
   * stop the box mid-turn (the "a turn probe" learnings). `turn_in_flight` is
   * true while a turn runs; when a specific `turn_message_id` is asked for, it
   * answers about THAT turn (true only while it is the live one).
   */
  turnProbe(requestedMessageId: string | null): {
    turn_in_flight: boolean;
    turn_message_id: string | null;
  } {
    if (requestedMessageId) {
      return {
        turn_in_flight: this.turnInFlight && this.activeTurnMessageId === requestedMessageId,
        turn_message_id: this.activeTurnMessageId,
      };
    }
    return { turn_in_flight: this.turnInFlight, turn_message_id: this.activeTurnMessageId };
  }

  /** The first user text names the session, like OpenCode's title adoption. */
  noteUserText(text: string): void {
    if (this.title.endsWith(' session') || this.title === 'Pi session') {
      const line = text.trim().split('\n')[0] ?? '';
      if (line) this.title = line.length > 80 ? `${line.slice(0, 77)}…` : line;
    }
  }

  /**
   * The same check every `/kortix/opencode/*` route makes, exposed so the
   * worker's RAW routes can make it too.
   *
   * `worker.ts` serves `/session/:id/prompt_async` and the bench surface
   * directly, and called nothing — so those routes were the only ones on the
   * box with no auth at all, while every sibling here had it. Accepts either
   * the session bearer or the signed user-context header, which is what the
   * API's sandbox proxy already sends (proven: an abort issued through the
   * proxy passes this).
   */
  authorize(req: IncomingMessage, url: URL): boolean {
    return this.authorized(req, url);
  }

  /**
   * Is this worker running with a credential at all?
   *
   * A SESSION box always is — the platform injects KORTIX_TOKEN — so every
   * product route can and must be gated. The BENCH runs this worker with no
   * token, and `authorized()` correctly refuses everything when there is none,
   * which would make the bench's own surface unreachable. So the bench-only
   * routes ask this first: gate when there is a credential to check, stay open
   * when there is provably no deployment to protect.
   *
   * `prompt_async` deliberately does NOT use this — it is the product's own
   * delivery route, so a box that somehow lost its token must fail CLOSED
   * rather than accept anonymous prompts.
   */
  requiresAuth(): boolean {
    return Boolean(this.opts.token);
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const token = this.opts.token;
    if (!token) return false;
    const auth = req.headers.authorization;
    if (auth === `Bearer ${token}`) return true;
    const header =
      (req.headers[KORTIX_USER_CONTEXT_HEADER] as string | undefined) ??
      url.searchParams.get(KORTIX_USER_CONTEXT_QUERY_PARAM) ??
      undefined;
    return verifyUserContext(header, token);
  }

  private sessionProjection() {
    return {
      id: this.rootId,
      title: this.title,
      parent_id: null,
      directory: this.opts.workspace ?? '/workspace',
      time: { created: this.createdAt, updated: this.updatedAt, compacting: null },
      revert: null,
    };
  }

  private selectedAgent(): Agent {
    const name = this.opts.agentName ?? Object.keys(this.opts.agents ?? {})[0] ?? 'build';
    const agent = this.opts.agents?.[name] ?? {};
    const model =
      this.opts.resolvedModel ?? agentModel(agent.model ?? this.opts.defaultModel ?? undefined);
    return {
      name,
      ...(agent.description !== undefined ? { description: agent.description } : {}),
      mode: agent.mode ?? 'primary',
      native: false,
      hidden: agent.hidden === true || agent.disable === true,
      ...(agent.top_p !== undefined ? { topP: agent.top_p } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.color !== undefined ? { color: agent.color } : {}),
      permission: compilePermissionRules(agent.permission ?? this.opts.permissionConfig),
      ...(model ? { model } : {}),
      ...(agent.variant !== undefined ? { variant: agent.variant } : {}),
      ...(agent.prompt !== undefined ? { prompt: agent.prompt } : {}),
      options: structuredClone(agent.options ?? {}),
      ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
    };
  }

  private toolList(): ToolList {
    return (this.opts.tools ?? []).map((tool) => ({
      id: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private stateDoc() {
    const agents = Object.entries(this.opts.agents ?? {}).map(([name, agent]) => ({
      name,
      description: agent.description ?? null,
      mode: null,
      native: false,
      hidden: null,
      color: null,
      variant: null,
      source: 'config' as const,
      model:
        this.opts.resolvedModel ?? agentModel(agent.model ?? this.opts.defaultModel ?? undefined),
    }));
    return {
      epoch: this.bus.epoch,
      seq: this.bus.headSeq,
      built_at: new Date().toISOString(),
      identity: {
        opencode_session_id: this.rootId,
        opencode_version: null,
        daemon_build: null,
        agent_config_etag: this.opts.agentConfigEtag ?? null,
        command_config_etag: this.opts.commandConfigEtag ?? null,
        skill_config_etag: this.opts.skillConfigEtag ?? null,
        head_seq: null,
      },
      agents: { known: true, value: agents },
      commands: { known: true, value: this.opts.commands ?? [] },
      skills: {
        known: true,
        value: (this.opts.skills ?? []).map((skill) =>
          projectSkillInfo(skill, this.opts.workspace ?? '/workspace'),
        ),
      },
      config: {
        known: true,
        value: {
          model: this.opts.resolvedModel
            ? `${this.opts.resolvedModel.providerID}/${this.opts.resolvedModel.modelID}`
            : this.opts.defaultModel ?? null,
          small_model: null,
          default_agent: this.opts.agentName ?? null,
          permission: this.opts.permissionConfig ?? null,
          instructions: null,
          enabled_providers: null,
        },
      },
      sessions: { known: true, value: [this.sessionProjection()] },
      statuses: { known: true, value: { [this.rootId]: this.status } },
      permissions: { known: true, value: this.opts.permissions?.list() ?? [] },
      questions: { known: true, value: this.opts.questions?.list() ?? [] },
    };
  }

  /**
   * Stage a rewind at `messageId` and TELL every client.
   *
   * The transcript change alone is invisible to anyone already connected —
   * `/messages` would disagree with what `/events` has said — so each removed
   * message is published as `message.removed`. Those events already have
   * consumers everywhere (the SDK parses them, mobile switches on them); until
   * now nothing produced them, which is exactly why rewind did nothing.
   */
  revertFrom(messageId: string): { removed: string[] } {
    const removed = this.transcript.revert(messageId);
    for (const id of removed) {
      this.publishWire({
        type: 'message.removed',
        properties: { messageID: id, sessionID: this.rootId },
        busOnly: true,
      });
    }
    return { removed };
  }

  /**
   * Commit a staged rewind — the new path has been taken.
   *
   * No events: clients were told `message.removed` when the rewind was staged,
   * so they already believe these are gone. This only makes that true, and
   * stops a later `restoreRewind()` splicing a dead branch back into a
   * conversation that has moved on.
   */
  commitStagedRevert(): string[] {
    return this.transcript.commitRevert();
  }

  /** Undo a staged rewind, re-announcing each message it had hidden. */
  restoreRevert(): { restored: string[] } {
    const restored = this.transcript.unrevert();
    for (const id of restored) {
      const message = this.transcript.messageById(id);
      if (!message) continue;
      // Bus-only again: `unrevert()` already put these back in the transcript,
      // and re-applying would be harmless but redundant work on every restore.
      this.publishWire({
        type: 'message.updated',
        properties: { sessionID: this.rootId, info: message.info },
        busOnly: true,
      });
      for (const part of message.parts) {
        this.publishWire({
          type: 'message.part.updated',
          properties: { sessionID: this.rootId, time: Date.now(), part },
          busOnly: true,
        });
      }
    }
    return { restored };
  }

  private opencodeSessionObject(): Pick<
    Session,
    'id' | 'slug' | 'projectID' | 'title' | 'directory' | 'time' | 'version' | 'permission'
  > {
    const s = this.sessionProjection();
    return {
      id: s.id,
      slug: s.id,
      projectID: this.opts.projectId ?? this.opts.sessionId,
      title: s.title,
      directory: s.directory,
      time: { created: s.time.created, updated: s.time.updated },
      version: 'pi',
      ...(this.opts.sessionPermission ? { permission: this.opts.sessionPermission() } : {}),
    };
  }

  /**
   * The RAW OpenCode list the control plane still probes:
   * `ensureOpencodeSessionPin` resolves the canonical pin from
   * `GET /session?directory=…` (apps/api/src/projects/opencode-mapping.ts),
   * and /start reports `starting` forever — then PARKS the healthy box at
   * the 90s no-progress budget — until that list answers. One root, same
   * auth posture as the namespace routes.
   */
  handleRawSessionList(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (url.pathname === '/global/event' && req.method === 'GET') {
      if (!this.authorized(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return true;
      }
      serveGlobalEventStream(res, this.bus, this.opts.workspace ?? '/workspace', {
        heartbeatMs: EVENT_HEARTBEAT_MS,
      });
      return true;
    }
    // POST /session/:id/abort — the Stop button's REAL path.
    //
    // There is a second abort handler under `/kortix/opencode/`, and it is not
    // the one the product calls. The SDK builds its OpenCode client with
    // `baseUrl = <backend>/p/<externalId>/8000` (`getClientForUrl` in
    // packages/sdk/src/core/runtime/client.ts), so `session.abort()` resolves
    // to `<base>/session/:id/abort` — HERE, at the raw root, with no prefix.
    //
    // This method was GET-only, so that POST fell through to the worker's
    // catch-all 404. Stop therefore did nothing on a pi session: the UI painted
    // "Interrupted" from its own optimistic receipt while the agent kept
    // generating to completion, and the turn closed later as if it had never
    // been stopped. Verified against pi.kortix.com 2026-09-01 — raw path 404,
    // prefixed path 200.
    //
    // Same contract as the prefixed handler: idempotent, root-scoped, and
    // `Agent.abort()` on an idle agent is a no-op.
    const rawAbort = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (rawAbort && req.method === 'POST') {
      if (!this.authorized(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return true;
      }
      const sessionId = decodePathSegment(rawAbort[1]!);
      if (sessionId === null) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
        return true;
      }
      if (sessionId !== this.rootId) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unknown session' }));
        return true;
      }
      const finish = () => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(true));
      };
      const fail = (error: unknown) => {
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: String((error as Error)?.message ?? error) }));
      };
      try {
        const outcome = this.opts.onAbort?.();
        if (outcome && typeof outcome.then === 'function') {
          void outcome.then(finish).catch(fail);
        } else {
          finish();
        }
      } catch (error) {
        fail(error);
      }
      return true;
    }
    // Pi's append-only transcript and Pi's in-memory model tree cannot be
    // rewound atomically. Fail closed instead of hiding messages from HTTP
    // while the next model call still receives the old branch.
    const rawRevert = url.pathname.match(/^\/session\/([^/]+)\/(revert|unrevert)$/);
    if (rawRevert && req.method === 'POST') {
      if (!this.authorized(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return true;
      }
      const sessionId = decodePathSegment(rawRevert[1]!);
      if (sessionId === null) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
        return true;
      }
      if (sessionId !== this.rootId) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unknown session' }));
        return true;
      }
      res.writeHead(501, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          code: 'feature_not_supported',
          error: 'session rewind is not supported by the durable Pi runtime',
        }),
      );
      return true;
    }
    // DELETE /session/:id/message/:messageId[/part/:partId] — raw OpenCode
    // message mutation routes used by the SDK queue controls. Queue ownership
    // stays in worker.ts; this surface only commits the matching transcript
    // removal after the worker confirms that the turn has not started.
    const rawDeleteMessage = url.pathname.match(
      /^\/session\/([^/]+)\/message\/([^/]+)(?:\/part\/([^/]+))?$/,
    );
    if (rawDeleteMessage && req.method === 'DELETE') {
      if (!this.authorized(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return true;
      }
      const sessionId = decodePathSegment(rawDeleteMessage[1]!);
      const messageId = decodePathSegment(rawDeleteMessage[2]!);
      const partId = rawDeleteMessage[3] ? decodePathSegment(rawDeleteMessage[3]) : undefined;
      if (sessionId === null || messageId === null || partId === null) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
        return true;
      }
      if (sessionId !== this.rootId) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unknown session' }));
        return true;
      }
      if (partId) {
        const message = this.transcript.messageById(messageId);
        if (!message?.parts.some((part) => part.id === partId)) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'unknown message part' }));
          return true;
        }
        // A view-only removal is data loss in disguise: the queued prompt
        // still reaches Pi, and a completed part returns after restart because
        // both the admission journal and Pi tree still contain it. Refuse the
        // mutation until branch-rewriting deletion exists.
        res.writeHead(409, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: 'message part deletion is not supported by the durable Pi runtime',
          }),
        );
        return true;
      }

      const finish = (outcome: 'deleted' | 'running' | 'missing') => {
        if (outcome === 'running') {
          res
            .writeHead(409, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'message is already running' }));
          return;
        }
        if (outcome === 'missing') {
          if (this.transcript.messageById(messageId)) {
            res
              .writeHead(409, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'message is durable history' }));
            return;
          }
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'unknown message' }));
          return;
        }
        this.publishWire({
          type: 'message.removed',
          properties: { messageID: messageId, sessionID: this.rootId },
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(true));
      };
      const outcome = this.opts.onDeleteMessage?.(messageId) ?? 'missing';
      if (typeof outcome === 'object' && 'then' in outcome) {
        void outcome.then(finish).catch((error) => {
          res
            .writeHead(503, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: String((error as Error)?.message ?? error) }));
        });
      } else {
        finish(outcome);
      }
      return true;
    }
    const rawPermissionMutation = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
    if (rawPermissionMutation && req.method === 'POST') {
      if (!this.authorized(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return true;
      }
      const requestId = decodePathSegment(rawPermissionMutation[1] ?? '');
      if (requestId === null) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
        return true;
      }
      const write = (status: number, body: unknown) =>
        res
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(body));
      void readRawJsonBody(req)
        .then(async (body) => {
          const value =
            body && typeof body === 'object' && !Array.isArray(body)
              ? (body as { reply?: unknown; message?: unknown })
              : null;
          if (
            !value ||
            (value.reply !== 'once' && value.reply !== 'always' && value.reply !== 'reject') ||
            (value.message !== undefined && typeof value.message !== 'string')
          ) {
            write(400, { error: 'reply must be once, always, or reject' });
            return;
          }
          if (!(await this.opts.permissions?.reply(requestId, value.reply, value.message))) {
            write(404, { error: 'permission request not found' });
            return;
          }
          write(200, true);
        })
        .catch((error) => {
          write(error instanceof RawBodyError ? error.status : error instanceof PermissionApprovalUnavailableError ? 503 : 400, {
            error: String((error as Error)?.message ?? error),
          });
        });
      return true;
    }
    const rawQuestionMutation = url.pathname.match(/^\/question\/([^/]+)\/(reply|reject)$/);
    if (rawQuestionMutation && req.method === 'POST') {
      if (!this.authorized(req, url)) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return true;
      }
      const requestId = decodePathSegment(rawQuestionMutation[1]!);
      if (requestId === null) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
        return true;
      }
      const action = rawQuestionMutation[2]!;
      const write = (status: number, body: unknown) =>
        res
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(body));
      if (action === 'reject') {
        if (!this.opts.questions?.reject(requestId)) {
          write(404, { error: 'question request not found' });
        } else {
          write(200, true);
        }
        return true;
      }
      void readRawJsonBody(req)
        .then((body) => {
          const answers =
            body && typeof body === 'object' && !Array.isArray(body)
              ? (body as { answers?: unknown }).answers
              : undefined;
          if (!Array.isArray(answers)) {
            write(400, { error: 'answers must be an array' });
            return;
          }
          try {
            if (!this.opts.questions?.reply(requestId, answers as string[][])) {
              write(404, { error: 'question request not found' });
              return;
            }
            write(200, true);
          } catch (error) {
            write(400, { error: String((error as Error)?.message ?? error) });
          }
        })
        .catch((error) => {
          write(error instanceof RawBodyError ? error.status : 400, {
            error: String((error as Error)?.message ?? error),
          });
        });
      return true;
    }
    if (req.method !== 'GET') return false;
    if (!this.authorized(req, url)) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
    if (url.pathname === '/session') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([this.opencodeSessionObject()]));
      return true;
    }
    if (url.pathname === '/session/status') {
      const finish = (status: { type: string }) => {
        const statuses = status.type === 'idle' ? {} : { [this.rootId]: status };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(statuses));
      };
      const fail = (error: unknown) => {
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: String((error as Error)?.message ?? error) }));
      };
      try {
        const outcome = this.opts.onStatus?.() ?? this.status;
        if ('then' in outcome && typeof outcome.then === 'function') {
          void outcome.then(finish).catch(fail);
        } else {
          finish(outcome as { type: string });
        }
      } catch (error) {
        fail(error);
      }
      return true;
    }
    if (url.pathname === '/config' || url.pathname === '/global/config') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        default_agent: this.opts.agentName ?? 'build',
        model: this.opts.resolvedModel
          ? `${this.opts.resolvedModel.providerID}/${this.opts.resolvedModel.modelID}`
          : this.opts.defaultModel ?? undefined,
        agent: this.opts.agents ?? {},
        permission: this.opts.permissionConfig,
        lsp: false,
      }));
      return true;
    }
    if (url.pathname === '/lsp/diagnostics') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({}));
      return true;
    }
    const todoSession = url.pathname.match(/^\/session\/([^/]+)\/todo$/);
    if (todoSession) {
      const sessionID = decodePathSegment(todoSession[1]!);
      const status = sessionID === null ? 400 : sessionID === this.rootId ? 200 : 404;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(
        status === 200 ? this.opts.todos?.() ?? [] : { error: 'unknown or invalid session' },
      ));
      return true;
    }
    if (url.pathname === '/question') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(this.opts.questions?.list() ?? []));
      return true;
    }
    if (url.pathname === '/permission') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(this.opts.permissions?.list() ?? []));
      return true;
    }
    if (url.pathname === '/command') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(this.opts.commands ?? []));
      return true;
    }
    if (url.pathname === '/agent') {
      const workspace = this.opts.workspace ?? '/workspace';
      if (!workspaceQueryMatches(url, workspace)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: 'agent workspace must equal the compiled environment workspace',
          }),
        );
        return true;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([this.selectedAgent()]));
      return true;
    }
    if (url.pathname === '/tool/ids' || url.pathname === '/experimental/tool/ids') {
      const workspace = this.opts.workspace ?? '/workspace';
      if (!workspaceQueryMatches(url, workspace)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: 'tool workspace must equal the compiled environment workspace',
          }),
        );
        return true;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(this.toolList().map((tool) => tool.id)));
      return true;
    }
    if (url.pathname === '/tool' || url.pathname === '/experimental/tool') {
      const workspace = this.opts.workspace ?? '/workspace';
      if (!workspaceQueryMatches(url, workspace)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: 'tool workspace must equal the compiled environment workspace',
          }),
        );
        return true;
      }
      const providers = url.searchParams.getAll('provider');
      const models = url.searchParams.getAll('model');
      if (
        providers.length !== 1 ||
        models.length !== 1 ||
        !providers[0]?.trim() ||
        !models[0]?.trim()
      ) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'tool provider and model must be non-empty strings' }));
        return true;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(this.toolList()));
      return true;
    }
    if (url.pathname === '/skill') {
      const workspace = this.opts.workspace ?? '/workspace';
      if (!workspaceQueryMatches(url, workspace)) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'skill workspace must equal the compiled environment workspace' }));
        return true;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify((this.opts.skills ?? []).map((skill) => projectSkillInfo(skill, workspace))),
        );
      return true;
    }
    // GET /session/:id/message[/:messageId] — OpenCode's raw transcript
    // compatibility surface. The API uses this path at turn end to write its
    // stopped-session mirror, and its lifecycle reconciler reads the same
    // route to prove whether a forwarded prompt ran. Serving only the
    // namespaced `/kortix/opencode/messages/:id` route left both control-plane
    // reads with a 404 even though the worker held the complete transcript.
    const rawMessage = url.pathname.match(/^\/session\/([^/]+)\/message(?:\/([^/]+))?$/);
    if (rawMessage) {
      const sessionId = decodePathSegment(rawMessage[1]!);
      const messageId = rawMessage[2] ? decodePathSegment(rawMessage[2]) : null;
      if (sessionId === null || (rawMessage[2] && messageId === null)) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
        return true;
      }
      if (sessionId !== this.rootId) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unknown session' }));
        return true;
      }
      if (messageId) {
        const message = this.transcript.messageById(messageId);
        if (!message) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'unknown message' }));
          return true;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
        return true;
      }
      const limitParam = url.searchParams.get('limit');
      const limitRaw = limitParam === null ? 0 : Number(limitParam);
      if (!Number.isInteger(limitRaw) || limitRaw < 0) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'limit must be a non-negative integer' }));
        return true;
      }
      const beforeParam = url.searchParams.get('before')?.trim() || null;
      if (beforeParam && limitRaw <= 0) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'before requires a positive limit' }));
        return true;
      }
      const before = beforeParam ? decodeRawMessageCursor(beforeParam) : null;
      if (beforeParam && !before) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'before cursor is invalid' }));
        return true;
      }
      const limit = limitRaw > 0 ? limitRaw : Math.max(this.transcript.count, 1);
      const page = this.transcript.page({ limit, before: before?.id ?? null });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const first = page.messages[0]?.info as { id?: string } | undefined;
      if (page.hasMore && first?.id) {
        const created = Number(
          (first as { time?: { created?: unknown } }).time?.created ?? wireIdTime(first.id) ?? 0,
        );
        const cursor = encodeRawMessageCursor({
          id: first.id,
          time: Number.isFinite(created) && created >= 0 ? created : 0,
        });
        const next = new URL(url.toString());
        next.searchParams.set('limit', String(limitRaw));
        next.searchParams.set('before', cursor);
        headers['access-control-expose-headers'] = 'Link, X-Next-Cursor';
        headers.link = `<${next.pathname}${next.search}>; rel="next"`;
        headers['x-next-cursor'] = cursor;
      }
      res.writeHead(200, headers).end(JSON.stringify(page.messages));
      return true;
    }
    const m = url.pathname.match(/^\/session\/([^/]+)$/);
    const decodedSession = m ? decodePathSegment(m[1]!) : null;
    if (m && decodedSession === null) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'path contains malformed percent-encoding' }));
      return true;
    }
    if (m && decodedSession === this.rootId) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(this.opencodeSessionObject()));
      return true;
    }
    return false;
  }

  /**
   * Serve one `/kortix/opencode/*` request. Returns false when the subpath is
   * not part of this surface (the caller then 404s it).
   */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const sub = url.pathname.slice('/kortix/opencode/'.length).replace(/\/+$/, '');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res
        .writeHead(status, { 'content-type': 'application/json', ...headers })
        .end(JSON.stringify(body));
      return true;
    };
    if (!this.authorized(req, url)) {
      return json(401, { error: 'unauthorized' });
    }

    if (sub === 'state' && req.method === 'GET') {
      const doc = this.stateDoc();
      const body = JSON.stringify(doc);
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag }).end();
        return true;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag }).end(body);
      return true;
    }

    if (sub.startsWith('messages/') && req.method === 'GET') {
      const sessionId = decodePathSegment(sub.slice('messages/'.length));
      if (sessionId === null)
        return json(400, { error: 'path contains malformed percent-encoding' });
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(Math.floor(limitRaw), MAX_MESSAGE_PAGE)
          : DEFAULT_MESSAGE_PAGE;
      const before = url.searchParams.get('before')?.trim() || null;
      // One root per worker: an unknown id is an empty transcript, not an error
      // — the client may probe with a stale id across a restart.
      const page =
        sessionId === this.rootId
          ? this.transcript.page({ limit, before })
          : { messages: [], hasMore: false };
      const first = page.messages[0]?.info as { id?: string } | undefined;
      const last = page.messages[page.messages.length - 1]?.info as { id?: string } | undefined;
      return json(200, {
        session_id: sessionId,
        epoch: this.bus.epoch,
        seq: this.bus.headSeq,
        head_seq: null,
        source: 'pi-worker',
        count: page.messages.length,
        has_more: page.hasMore,
        first_message_id: first?.id ?? null,
        last_message_id: last?.id ?? null,
        dropped: 0,
        attachments_referenced: 0,
        attachment_bytes_saved: 0,
        tool_outputs_truncated: 0,
        messages: page.messages,
      });
    }

    // POST session/:id/abort — the client's Stop button.
    //
    // Placed BEFORE the GET read below because both match `session/`, and this
    // one is the state change: `session.abort({ sessionID })` on the OpenCode
    // runtime client resolves to exactly this path. Answering 200 without
    // calling the agent would be worse than 404ing, so the handler is only
    // reached once the session id matches this root.
    const abortMatch = sub.match(/^session\/([^/]+)\/abort$/);
    if (abortMatch && req.method === 'POST') {
      const sessionId = decodePathSegment(abortMatch[1]!);
      if (sessionId === null)
        return json(400, { error: 'path contains malformed percent-encoding' });
      if (sessionId !== this.rootId) return json(404, { error: 'unknown session' });
      // Idempotent by contract: the UI can send Stop against a turn row that is
      // already closed, and `Agent.abort()` on an idle agent is a no-op. An
      // unwired surface (the bench) answers the same way.
      const finish = () => json(200, { ok: true });
      const fail = (error: unknown) =>
        json(503, { error: String((error as Error)?.message ?? error) });
      try {
        const outcome = this.opts.onAbort?.();
        if (outcome && typeof outcome.then === 'function') {
          void outcome.then(finish).catch(fail);
        } else {
          finish();
        }
      } catch (error) {
        fail(error);
      }
      return true;
    }

    if (sub.startsWith('session/') && req.method === 'GET') {
      const sessionId = decodePathSegment(sub.slice('session/'.length));
      if (sessionId === null)
        return json(400, { error: 'path contains malformed percent-encoding' });
      if (sessionId !== this.rootId) return json(404, { error: 'unknown session' });
      // OpenCode's own Session shape, minimally: id, title, time.
      return json(200, this.opencodeSessionObject());
    }

    if (sub === 'events' && req.method === 'GET') {
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;
      const epoch = url.searchParams.get('epoch')?.trim() || null;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-kortix-epoch': this.bus.epoch,
      });
      let closed = false;
      let lastSent = -1;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          res.write(chunk);
        } catch {
          closed = true;
        }
      };
      const send = (event: WireEvent) => {
        if (event.seq <= lastSent) return;
        lastSent = event.seq;
        write(`event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      let replaying = true;
      const pending: WireEvent[] = [];
      const subscription = this.bus.subscribe(
        (event) => {
          if (replaying) pending.push(event);
          else send(event);
        },
        { since, epoch },
      );
      write(
        `event: kortix.hello\ndata: ${JSON.stringify({
          type: 'kortix.hello',
          epoch: this.bus.epoch,
          head_seq: this.bus.headSeq,
          first_seq: this.bus.firstSeq,
          since,
          at: Date.now(),
        })}\n\n`,
      );
      if (subscription.resync) {
        write(
          `event: kortix.resync\ndata: ${JSON.stringify({ type: 'kortix.resync', ...subscription.resync })}\n\n`,
        );
        lastSent = this.bus.headSeq;
      }
      for (const event of subscription.replay) send(event);
      replaying = false;
      for (const event of pending) send(event);
      pending.length = 0;
      const heartbeat = setInterval(() => {
        write(
          `event: kortix.heartbeat\ndata: ${JSON.stringify({
            type: 'kortix.heartbeat',
            at: Date.now(),
            head_seq: this.bus.headSeq,
          })}\n\n`,
        );
      }, EVENT_HEARTBEAT_MS);
      heartbeat.unref?.();
      req.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
        subscription.unsubscribe();
      });
      return true;
    }

    // Lazy passthroughs the worker has no upstream for (vcs-diff, config,
    // todo, …): an honest 404 — the product degrades those panels gracefully.
    return json(404, { error: `no pi handler for /kortix/opencode/${sub}` });
  }
}
