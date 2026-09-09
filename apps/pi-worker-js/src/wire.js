// THE STREAM THE PRODUCT ACTUALLY SUBSCRIBES TO.
//
// A cell's `/events` carries pi's own AgentEvents verbatim, which is the right
// contract for the harness and the wrong one for the UI: the web client's
// reducer applies OpenCode wire events, and applies text incrementally ONLY
// from `message.part.delta`. So the answer never appeared as it was written.
//
// Measured on dev 2026-09-09 against a live session, watching the stream the
// frontend opens (`GET /v1/projects/:p/sessions/:s/events`) for 75 s across a
// full answer:
//
//   959 ms   kortix.runtime.status {"state":"down","reason":"daemon_503"}
//   then     control frames and heartbeats only, runtime_seq null throughout
//   never    a single runtime content frame
//
// The API opens `<box>/kortix/opencode/events`; the cell served no such route,
// so the pump announced `down` and retried on the backoff ladder forever.
//
// This module is the bus behind that route: a monotonic sequence, a bounded
// replay ring, and the SSE framing. Separate from worker.js so the sequencing
// and the resync decision can be tested without a cell, a socket or a model.

/**
 * How often an idle stream says something.
 *
 * Ten seconds because the observed cut was at 15161 ms with no traffic: two of
 * these fit inside that, so a stream that has nothing to report still survives
 * a quiet turn. The reference daemon uses 15 s against a 60 s client budget;
 * this one answers to an edge, which is stricter.
 */
export const WIRE_HEARTBEAT_MS = 10_000;

/**
 * THE HEARTBEAT IS A FRAME, NOT A COMMENT.
 *
 * The stream used to keep itself alive with an SSE comment (`: beat`). A
 * comment never reaches JavaScript — EventSource and the OpenCode SDK's SSE
 * client both discard it — so to the web app a quiet cell looked DEAD: its
 * watchdog counts parsed frames only (packages/sdk event-stream.ts,
 * `resetHeartbeat()` on every yielded item), fired "SSE heartbeat timeout,
 * forcing reconnect", and the page flickered between Connecting and connected
 * for as long as the session sat idle. Measured 2026-09-09 in a real Chromium
 * against pi-js.kortix.com: 24 s on "Connecting" with every in-box call 200.
 *
 * A real OpenCode server heartbeats with an EVENT. This is that event: an
 * unknown type to the reducer (chat-events.ts returns null for it), activity
 * to the watchdog, and UNSEQUENCED — no `id:`, no `seq` — so it never enters
 * the ring, never advances a cursor, and a replay never contains one.
 */
export function heartbeatFrame(at = Date.now()) {
  return `event: server.heartbeat\ndata: ${JSON.stringify({ type: "server.heartbeat", at })}\n\n`;
}

/**
 * The frame a real OpenCode server sends first. The SDK maps it to
 * `{ type: "connection", status: "connected" }`; a client that waits for it
 * before calling the stream established is right to. Unsequenced, like hello.
 */
export function connectedFrame() {
  return `event: server.connected\ndata: ${JSON.stringify({ type: "server.connected" })}\n\n`;
}

/** How many frames stay replayable. A turn is tens of frames; this is many turns. */
export const WIRE_RING_MAX = 2000;

/**
 * One SSE frame, in the shape `forwardRuntimeFrame` re-emits verbatim:
 * `event:` names the type, `id:` carries the cursor, `data:` is the envelope
 * with its own `seq` so a consumer reading only the body still has the number.
 */
export function encodeFrame(frame, seq) {
  const body = JSON.stringify({ ...frame, seq });
  return `event: ${frame.type}\nid: ${seq}\ndata: ${body}\n\n`;
}

/**
 * What a reconnecting client is owed.
 *
 * `null` epoch or a DIFFERENT epoch means the cursor belongs to a boot that no
 * longer exists — every seq it holds is meaningless here, so the honest answer
 * is a resync, never a replay that would silently start mid-conversation.
 * A `since` older than the ring is the same problem for a different reason:
 * the frames are gone, and pretending otherwise hands the client a gap it
 * cannot see.
 */
export function replayPlan({ since, epoch, ourEpoch, firstSeq, headSeq }) {
  if (epoch && epoch !== ourEpoch) return { kind: "resync", reason: "epoch_changed" };
  const from = Number.isFinite(since) && since !== null ? Number(since) : null;
  if (from === null) return { kind: "live" };
  if (from > headSeq) return { kind: "resync", reason: "cursor_ahead" };
  // An empty ring cannot be behind anything: nothing has happened yet.
  if (headSeq === 0) return { kind: "live" };
  if (from < firstSeq - 1) return { kind: "resync", reason: "gap" };
  return { kind: "replay", from };
}

export class WireBus {
  constructor({ epoch, ringMax = WIRE_RING_MAX } = {}) {
    this.epoch = String(epoch ?? "");
    this.ringMax = ringMax;
    this.seq = 0;
    this.ring = [];
    this.listeners = new Set();
  }

  get firstSeq() {
    return this.ring.length ? this.ring[0].seq : this.seq + 1;
  }

  /**
   * Publish frames, in order, to the ring and to every live listener.
   *
   * `transcriptOnly` frames are dropped here on purpose and are not a mistake:
   * the snapshot (`message.part.updated`) REPLACES a part's text while the
   * delta APPENDS to it, so putting both on the bus double-counts every
   * character. The snapshot's job is the REST read; the bus carries the delta.
   */
  publish(frames) {
    const out = [];
    for (const frame of frames ?? []) {
      if (!frame || typeof frame.type !== "string" || frame.transcriptOnly) continue;
      if (this.isReasoning(frame)) continue;
      const seq = ++this.seq;
      const line = encodeFrame(frame, seq);
      this.ring.push({ seq, line });
      if (this.ring.length > this.ringMax) this.ring.shift();
      out.push(line);
    }
    if (out.length === 0) return 0;
    const joined = out.join("");
    for (const w of [...this.listeners]) {
      try { w.write(joined); } catch { this.listeners.delete(w); }
    }
    return out.length;
  }

  /**
   * A REASONING PART IS NOT AN ANSWER, and putting it on the wire renders it
   * as one.
   *
   * `deepseek-v4-flash` is a reasoning model: every reply arrives as two parts,
   * the model's thinking and then the answer. The SDK's own transcript
   * formatter hides a `reasoning` part unless `thinking` is asked for
   * (packages/sdk/src/transcript.ts — it returns an empty string), so the
   * product's default is not to show it. Streamed onto the bus it was painted
   * like any other text and the user saw two answers, the first being the
   * model talking to itself. Measured 2026-09-09 on a one-word reply:
   *
   *   part p0  type=reasoning  'The user asked to reply with exactly one word…'
   *   part p1  type=text       'streamcheck'
   *
   * The transcript still keeps it — this drops it from the LIVE stream only,
   * so a reader that wants thinking can still fetch it.
   */
  isReasoning(frame) {
    const props = frame.properties ?? {};
    if (frame.type === "message.part.updated") {
      const t = props.part?.type;
      if (t === "reasoning" || t === "thinking") {
        this.reasoningParts = this.reasoningParts ?? new Set();
        if (props.part?.id) this.reasoningParts.add(props.part.id);
        return true;
      }
      return false;
    }
    if (frame.type === "message.part.delta") {
      // A delta names only its part id, so the snapshot that introduced the
      // part is what tells us the type — and it always precedes the deltas.
      return !!this.reasoningParts?.has(props.partID);
    }
    return false;
  }

  /**
   * DOES THIS FRAME CARRY TEXT THE USER WILL SEE?
   *
   * `message.updated` is emitted when the assistant message OPENS, before the
   * model has produced anything, so a turn timer that stops on the first frame
   * measures nothing about the model. Measured on dev 2026-09-09 against a live
   * session: that mark read `modelFirstByte: 2` while the turn took 1602 ms.
   *
   * Visible text means a text delta, or the snapshot that opens a text part.
   * Reasoning is excluded for the same reason `publish` drops it: it is not the
   * answer, and timing to it would report a turn as responsive while the user
   * still has an empty bubble.
   */
  carriesVisibleText(frame) {
    if (!frame || typeof frame.type !== "string") return false;
    const props = frame.properties ?? {};
    if (frame.type === "message.part.updated") {
      return props.part?.type === "text" && !!props.part?.text;
    }
    if (frame.type === "message.part.delta") {
      // A delta names only its part id. `publish` has already recorded which
      // parts are reasoning, which is why this is asked AFTER publishing and
      // not before: the snapshot that introduces a part always precedes its
      // deltas, so by now the set is complete for anything that could be asked.
      if (this.reasoningParts?.has(props.partID)) return false;
      return typeof props.delta === "string" && props.delta.length > 0;
    }
    return false;
  }

  /** The opening bytes for one attach: hello, then whatever replay is owed. */
  opening({ since = null, epoch = null } = {}) {
    const plan = replayPlan({
      since, epoch, ourEpoch: this.epoch, firstSeq: this.firstSeq, headSeq: this.seq,
    });
    // The hello is NOT sequenced. It carries the epoch and the head, and giving
    // it a number would advance a cursor over a frame that holds no content.
    let out = `event: kortix.hello\ndata: ${JSON.stringify({
      type: "kortix.hello", epoch: this.epoch, seq: this.seq,
    })}\n\n`;
    // What an OpenCode client expects first — see connectedFrame.
    out += connectedFrame();
    if (plan.kind === "resync") {
      out += `event: kortix.resync\ndata: ${JSON.stringify({
        type: "kortix.resync", epoch: this.epoch,
        reason: plan.reason, first_seq: this.firstSeq, head_seq: this.seq,
      })}\n\n`;
      return out;
    }
    if (plan.kind === "replay") {
      for (const entry of this.ring) if (entry.seq > plan.from) out += entry.line;
    }
    return out;
  }
}
