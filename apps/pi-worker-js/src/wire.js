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
