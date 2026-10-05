// The cell's event sequencer and its two SSE framings, matching kortixd's
// (services/event-bus/kortix-event-bus.ts, routes/kortix/runtime.ts
// `GET /events`, harness/pi/surface.ts `/global/event`).
//
// One dense sequence per epoch. The epoch is this isolate: a rebuilt isolate
// starts at seq 0, so a cursor from the old one is answered with a resync,
// never a replay that silently starts mid-conversation. The ring is memory,
// not storage: the transcript (transcript.js) is the durable record, and
// `kortix.resync` names where to re-read it.

export const RING_MAX = 2000;
export const EVENT_HEARTBEAT_MS = 15_000;
/** The ids the SDK reads to recover after a resync. */
export const EVENT_RECOVERY = ["GET /kortix/runtime/state", "GET /kortix/runtime/messages/:sessionId?limit=20"];

export class KortixEventBus {
  constructor({ epoch, ringMax = RING_MAX, now = () => Date.now() } = {}) {
    this.epoch = epoch ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.ringMax = ringMax;
    this.now = now;
    this.seq = 0;
    this.ring = [];
    this.listeners = new Set();
  }

  get headSeq() {
    return this.seq;
  }

  /** Oldest seq still replayable; `headSeq` when the ring is empty. */
  get firstSeq() {
    return this.ring.length ? this.ring[0].seq : this.seq;
  }

  publish(type, payload, session) {
    const event = { seq: ++this.seq, type, at: this.now(), payload, ...(session ? { session } : {}) };
    this.ring.push(event);
    if (this.ring.length > this.ringMax) this.ring.shift();
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { this.listeners.delete(listener); }
    }
    return event;
  }

  /**
   * Live events from now, plus what `since` is owed. A different epoch, a
   * cursor older than the ring, or one ahead of the head is a resync.
   */
  subscribe(listener, { since = null, epoch = null } = {}) {
    let resync = null;
    let replay = [];
    const makeResync = (reason) => ({ reason, epoch: this.epoch, first_seq: this.firstSeq, head_seq: this.headSeq, recover: EVENT_RECOVERY });
    if (since !== null) {
      if (epoch !== null && epoch !== this.epoch) resync = makeResync("epoch-changed");
      else if (since > this.seq) resync = makeResync("ahead-of-head");
      else if (this.ring.length && since < this.firstSeq - 1) resync = makeResync("gap-too-old");
      else replay = this.ring.filter((e) => e.seq > since);
    }
    this.listeners.add(listener);
    return { replay, resync, unsubscribe: () => this.listeners.delete(listener) };
  }
}

const encoder = new TextEncoder();

function sseResponse(start, cancel) {
  return new Response(
    new ReadableStream({ start, cancel }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } },
  );
}

/**
 * `GET /global/event` and `/event`: the stream the SDK subscribes to. OpenCode
 * framing, `data: {id, type, properties}`. The top-level `id` is the SDK's
 * idempotency key for `message.part.delta`: without it a redelivered delta is
 * appended twice. `epoch:seq` because seq restarts with the isolate.
 * `kortix.*` frames are the runtime stream's own and stay off this one.
 */
export function globalEventStream(bus, { heartbeatMs = 10_000 } = {}) {
  let unsubscribe = null;
  let beat = null;
  return sseResponse(
    (controller) => {
      let closed = false;
      const write = (text) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { closed = true; }
      };
      write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      unsubscribe = bus.subscribe((event) => {
        if (event.type.startsWith("kortix.")) return;
        write(`data: ${JSON.stringify({ id: `${bus.epoch}:${event.seq}`, type: event.type, properties: event.payload })}\n\n`);
      }).unsubscribe;
      // A typed heartbeat, not a `:` comment: a comment never reaches the SDK's
      // parser, and its watchdog counts parsed frames. Unsequenced.
      beat = setInterval(() => write(`data: ${JSON.stringify({ type: "server.heartbeat", properties: {} })}\n\n`), heartbeatMs);
    },
    () => {
      if (beat) clearInterval(beat);
      unsubscribe?.();
    },
  );
}

/**
 * `GET /kortix/runtime/events?since&epoch`: the sequenced runtime stream.
 * `kortix.hello` opens it with the exact cursor; a resync names what to
 * re-read; `kortix.heartbeat` carries no seq.
 */
export function runtimeEventStream(bus, { since = null, epoch = null, heartbeatMs = EVENT_HEARTBEAT_MS } = {}) {
  let unsubscribe = null;
  let beat = null;
  return sseResponse(
    (controller) => {
      let closed = false;
      let replaying = true;
      let lastSent = -1;
      const pending = [];
      const write = (text) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { closed = true; }
      };
      const send = (event) => {
        if (event.seq <= lastSent) return;
        lastSent = event.seq;
        write(`event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const sub = bus.subscribe((event) => (replaying ? pending.push(event) : send(event)), { since, epoch });
      unsubscribe = sub.unsubscribe;
      write(`event: kortix.hello\ndata: ${JSON.stringify({ type: "kortix.hello", epoch: bus.epoch, head_seq: bus.headSeq, first_seq: bus.firstSeq, since, at: Date.now() })}\n\n`);
      if (sub.resync) {
        write(`event: kortix.resync\ndata: ${JSON.stringify({ type: "kortix.resync", ...sub.resync })}\n\n`);
        lastSent = bus.headSeq;
      }
      for (const event of sub.replay) send(event);
      replaying = false;
      for (const event of pending) send(event);
      pending.length = 0;
      beat = setInterval(() => write(`event: kortix.heartbeat\ndata: ${JSON.stringify({ type: "kortix.heartbeat", at: Date.now(), head_seq: bus.headSeq })}\n\n`), heartbeatMs);
    },
    () => {
      if (beat) clearInterval(beat);
      unsubscribe?.();
    },
  );
}
