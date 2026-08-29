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
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mintWireMessageId, wireIdTime } from './wire-message-id';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Auth — the daemon's user-context codec, verify side.
// ---------------------------------------------------------------------------

export const KORTIX_USER_CONTEXT_HEADER = 'x-kortix-user-context';
export const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context';

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
      else if (opts.since < this.firstSeq - 1 && this.ring.length > 0 && opts.since < this.ring[0]!.seq - 1)
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
    }
  }

  page(opts: { limit: number; before: string | null }): {
    messages: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>;
    hasMore: boolean;
  } {
    const eligible = opts.before ? this.order.filter((id) => id < (opts.before as string)) : this.order;
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

export interface RuntimeSurfaceOptions {
  sessionId: string;
  /** The worker's own KORTIX_TOKEN — service bearer AND user-context secret. */
  token?: string;
  agentName?: string;
  agentConfigEtag?: string | null;
  agents?: Record<string, { description?: string; model?: string }>;
  defaultModel?: string | null;
  workspace?: string;
}

function agentModel(ref: string | undefined): { providerID: string; modelID: string } | null {
  if (!ref || !ref.includes('/')) return null;
  const native = ref.startsWith('kortix/') ? ref.slice('kortix/'.length) : ref;
  const slash = native.indexOf('/');
  return { providerID: native.slice(0, slash), modelID: native.slice(slash + 1) };
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
    this.lastMintedTime = minted.time;
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
   * Restored pi messages carry NO wire id (they are storage entries, not wire
   * frames), so ids are minted here in restore order. That is safe and it is
   * why this must run BEFORE any live turn: `mintMessageId` seeds each new id
   * from `lastMintedTime`, so every reply after the restore sorts above the
   * whole restored transcript rather than back inside it.
   *
   * Applied straight to the transcript, not through `publishWire`: history is
   * not news. Replaying it onto the bus would hand a reconnecting client a
   * burst of "new" events for messages it already has.
   */
  seedRestoredMessages(
    messages: Array<{
      role?: string;
      content?: unknown;
      timestamp?: number | string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    }>,
  ): number {
    let seeded = 0;
    // A tool call and its result are TWO durable messages (the assistant's
    // `toolCall` block, then a `role: 'toolResult'` message pointing back at it
    // by `toolCallId`). The live wire shape is one `tool` part that moves from
    // running to completed, so the result has to fold onto the part the call
    // created rather than become a bubble of its own — otherwise a resumed
    // session shows "Successfully wrote 4 bytes to number.txt" as something
    // the assistant SAID, and the write card it belongs to is missing.
    const toolParts = new Map<string, { messageId: string; partId: string; tool: string; input: unknown }>();

    for (const message of messages) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const created = typeof message.timestamp === 'number' ? message.timestamp : Date.now();

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
            : { status: 'completed', output }),
          input: pending.input,
          time: { start: created, end: created },
        });
        continue;
      }

      const role = message.role === 'user' ? 'user' : 'assistant';
      const id = this.mintMessageId();
      const parts: Array<{ kind: 'text'; text: string } | { kind: 'tool'; call: any }> = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
        if (typeof b.text === 'string' && b.text.length > 0) parts.push({ kind: 'text', text: b.text });
        else if (b.type === 'toolCall' && b.name) parts.push({ kind: 'tool', call: b });
      }
      // A message with nothing renderable would show as an empty bubble.
      if (parts.length === 0) continue;

      this.transcript.apply({
        type: 'message.updated',
        properties: {
          sessionID: this.rootId,
          info: { id, role, sessionID: this.rootId, time: { created } },
        },
      });
      parts.forEach((part, index) => {
        const partId = `${id}-p${index}`;
        if (part.kind === 'text') {
          this.transcript.apply({
            type: 'message.part.updated',
            properties: {
              sessionID: this.rootId,
              part: { id: partId, messageID: id, sessionID: this.rootId, type: 'text', text: part.text },
            },
          });
          return;
        }
        const entry = { messageId: id, partId, tool: String(part.call.name), input: part.call.arguments };
        // Left 'running' on purpose when no result follows: that is exactly
        // what an interrupted turn was, and claiming it completed would be a lie.
        this.applyToolPart(entry, { status: 'running', input: entry.input, time: { start: created } });
        if (typeof part.call.id === 'string') toolParts.set(part.call.id, entry);
      });
      seeded++;
    }
    return seeded;
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
    this.transcript.apply(wire);
    const session =
      (wire.properties.sessionID as string | undefined) ??
      ((wire.properties.info as { sessionID?: string } | undefined)?.sessionID ??
        (wire.properties.part as { sessionID?: string } | undefined)?.sessionID);
    this.bus.publish(wire.type, wire.properties, session);
  }

  /** Record turn start/end so the health turn probe can report it. */
  markTurn(userMessageId: string | null, inFlight: boolean): void {
    this.turnInFlight = inFlight;
    this.activeTurnMessageId = inFlight ? userMessageId : null;
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
      model: agentModel(agent.model ?? this.opts.defaultModel ?? undefined),
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
        head_seq: null,
      },
      agents: { known: true, value: agents },
      commands: { known: true, value: [] },
      config: {
        known: true,
        value: {
          model: this.opts.defaultModel ?? null,
          small_model: null,
          default_agent: this.opts.agentName ?? null,
          permission: null,
          instructions: null,
          enabled_providers: null,
        },
      },
      sessions: { known: true, value: [this.sessionProjection()] },
      statuses: { known: true, value: { [this.rootId]: this.status } },
      permissions: { known: true, value: [] },
      questions: { known: true, value: [] },
    };
  }

  private opencodeSessionObject() {
    const s = this.sessionProjection();
    return {
      id: s.id,
      title: s.title,
      directory: s.directory,
      time: { created: s.time.created, updated: s.time.updated },
      version: 'pi',
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
    if (req.method !== 'GET') return false;
    if (!this.authorized(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
    if (url.pathname === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([this.opencodeSessionObject()]));
      return true;
    }
    const m = url.pathname.match(/^\/session\/([^/]+)$/);
    if (m && decodeURIComponent(m[1]!) === this.rootId) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.opencodeSessionObject()));
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
      const sessionId = decodeURIComponent(sub.slice('messages/'.length));
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

    if (sub.startsWith('session/') && req.method === 'GET') {
      const sessionId = decodeURIComponent(sub.slice('session/'.length));
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
