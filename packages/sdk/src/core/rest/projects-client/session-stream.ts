// The session runtime stream — ONE connection for everything that MOVES in a
// session.
//
// `GET /projects/:projectId/sessions/:sessionId/stream` multiplexes two sources
// that a client used to reach separately, and used to poll around:
//
//   channel 'runtime' — the sandbox daemon's sequenced events, forwarded
//     verbatim by the API. `seq` is the DAEMON's number inside the daemon's
//     boot `epoch`; `payload` is OpenCode's `properties` unchanged, so an
//     existing reducer applies it with no translation.
//   channel 'control' — the API's own snapshots: the prompt queue, the turn
//     verdict, wake/boot progress, the transcript mirror's watermark, and the
//     runtime projection. `cseq` inside `cepoch` — a SEPARATE id-space.
//   channel 'stream'  — the connection's own frames: hello, heartbeat, and the
//     runtime up/down status. These advance NEITHER cursor.
//
// THE TWO CURSORS ARE NEVER MIXED. A `cseq` sent where a `seq` belongs
// addresses a position that does not exist on the other side, and the failure
// is silent: the server replays from the wrong place and the client believes it
// is caught up. `sessionStreamPath` therefore refuses to send half a cursor —
// a `seq` without its `epoch`, or a `cseq` without its `cepoch`, is dropped
// rather than sent hopefully.
//
// This module is deliberately low-level: a URL, a codec, and a reader. It owns
// no reconnect policy and no store. The session controller that consumes it
// owns both.

import { ApiError } from '../../http/api-client';
import { platformConfig } from '../../http/config';
import { authenticatedFetch } from '../../http/auth';

/** A position on both channels. `null` on a field means "no position yet". */
export interface SessionStreamCursor {
  /** The daemon boot the `seq` belongs to. */
  epoch?: string | null;
  /** The daemon's own dense sequence number. */
  seq?: number | null;
  /** The API PROCESS the `cseq` belongs to. */
  cepoch?: string | null;
  /** The control channel's dense sequence number. */
  cseq?: number | null;
}

export interface ResolvedSessionStreamCursor {
  epoch: string | null;
  seq: number | null;
  cepoch: string | null;
  cseq: number | null;
}

/** A frame about the CONNECTION. Advances neither cursor. */
export interface SessionStreamMetaFrame {
  channel: 'stream';
  type: string;
  [key: string]: unknown;
}

/** A daemon envelope, forwarded verbatim. `payload` is OpenCode's `properties`. */
export interface SessionStreamRuntimeFrame {
  channel: 'runtime';
  type: string;
  /** Absent on `kortix.hello` / `kortix.resync` / `kortix.heartbeat`, which
   *  carry no replayable identity and must NOT advance the cursor. */
  seq?: number;
  epoch?: string | null;
  at?: number;
  payload?: unknown;
  session?: string;
  [key: string]: unknown;
}

/** An API snapshot. Every one carries its subsystem's COMPLETE state, so a
 *  missed frame is corrected by the next rather than lost. */
export interface SessionStreamControlFrame {
  channel: 'control';
  type: string;
  cseq?: number;
  cepoch?: string;
  at?: number;
  payload?: unknown;
  [key: string]: unknown;
}

export type SessionStreamFrame =
  | SessionStreamMetaFrame
  | SessionStreamRuntimeFrame
  | SessionStreamControlFrame;

/**
 * The path (relative to `backendUrl`) for a session stream at a given position.
 *
 * Half a cursor is dropped, never sent: see the module header.
 */
export function sessionStreamPath(
  projectId: string,
  sessionId: string,
  cursor?: SessionStreamCursor,
): string {
  const search = new URLSearchParams();
  if (cursor) {
    if (typeof cursor.seq === 'number' && cursor.epoch) {
      search.set('since', String(cursor.seq));
      search.set('epoch', cursor.epoch);
    }
    if (typeof cursor.cseq === 'number' && cursor.cepoch) {
      search.set('since_control', String(cursor.cseq));
      search.set('cepoch', cursor.cepoch);
    }
  }
  const qs = search.toString();
  return `/projects/${projectId}/sessions/${sessionId}/stream${qs ? `?${qs}` : ''}`;
}

/**
 * The composite cursor the server writes into every frame's SSE `id:`.
 *
 * `epoch|seq|cepoch|cseq`, blanks for "no position". It exists so a
 * `Last-Event-ID` reconnect — the only thing a browser `EventSource` sends on
 * its own — restores BOTH channels, not one of them.
 */
export function formatSessionStreamCursor(cursor: SessionStreamCursor): string {
  return [
    cursor.epoch ?? '',
    typeof cursor.seq === 'number' ? String(cursor.seq) : '',
    cursor.cepoch ?? '',
    typeof cursor.cseq === 'number' ? String(cursor.cseq) : '',
  ].join('|');
}

/** Inverse of {@link formatSessionStreamCursor}. Anything malformed decodes to
 *  "no position" — a wrong position is far worse than none. */
export function parseSessionStreamCursor(
  value: string | null | undefined,
): ResolvedSessionStreamCursor {
  const empty: ResolvedSessionStreamCursor = {
    epoch: null,
    seq: null,
    cepoch: null,
    cseq: null,
  };
  if (!value) return empty;
  const parts = value.split('|');
  if (parts.length !== 4) return empty;
  const [epoch, seq, cepoch, cseq] = parts;
  return {
    epoch: epoch ? epoch : null,
    seq: seq && /^\d+$/.test(seq) ? Number(seq) : null,
    cepoch: cepoch ? cepoch : null,
    cseq: cseq && /^\d+$/.test(cseq) ? Number(cseq) : null,
  };
}

export interface ReadSessionStreamOptions {
  cursor?: SessionStreamCursor;
  signal?: AbortSignal;
  /**
   * Called with the position AFTER each frame that advanced one.
   *
   * This is the value to persist and hand back on reconnect: it reflects what
   * the consumer has actually SEEN, which is the only honest resume point.
   */
  onCursor?: (cursor: ResolvedSessionStreamCursor) => void;
}

/**
 * Read the session stream as an async iterable of frames.
 *
 * No reconnect policy lives here on purpose: retry, backoff and "what do I do
 * about a resync" are decisions the consumer's store has to make, and a reader
 * that reconnected silently would hide exactly the gap the cursors exist to
 * expose.
 */
export async function* readSessionStream(
  projectId: string,
  sessionId: string,
  options?: ReadSessionStreamOptions,
): AsyncGenerator<SessionStreamFrame> {
  const base = (platformConfig().backendUrl || '').replace(/\/$/, '');
  const url = `${base}${sessionStreamPath(projectId, sessionId, options?.cursor)}`;

  const response = await authenticatedFetch(url, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    signal: options?.signal,
  });

  if (!response.ok || !response.body) {
    // A stream that opens and yields nothing is indistinguishable from a
    // healthy quiet session, so a failed open MUST throw rather than return an
    // empty iterator.
    const detail = await response.text().catch(() => '');
    await response.body?.cancel().catch(() => {});
    throw new ApiError(`session stream failed: ${response.status}`, {
      status: response.status,
      detail: detail || undefined,
      url,
    });
  }

  const cursor: ResolvedSessionStreamCursor = {
    epoch: options?.cursor?.epoch ?? null,
    seq: options?.cursor?.seq ?? null,
    cepoch: options?.cursor?.cepoch ?? null,
    cseq: options?.cursor?.cseq ?? null,
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = nextBoundary(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = toFrame(raw);
        if (frame) {
          if (advanceCursor(cursor, frame)) options?.onCursor?.({ ...cursor });
          yield frame;
        }
        boundary = nextBoundary(buffer);
      }
    }
  } finally {
    reader.releaseLock();
    await response.body.cancel().catch(() => {});
  }
}

function nextBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/**
 * Turn one raw SSE frame into a typed one.
 *
 * Routed on `channel`, never on the event NAME: the runtime channel carries
 * OpenCode's own event types, and this SDK must not need a release every time
 * OpenCode adds one.
 */
function toFrame(raw: string): SessionStreamFrame | null {
  const data: string[] = [];
  let event: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (data.length === 0) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data.join('\n')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const channel =
    parsed.channel === 'runtime' || parsed.channel === 'control' ? parsed.channel : 'stream';
  const type = typeof parsed.type === 'string' ? parsed.type : (event ?? 'message');
  return { ...parsed, channel, type } as SessionStreamFrame;
}

/** Advance whichever cursor this frame belongs to. Returns whether it moved. */
function advanceCursor(
  cursor: ResolvedSessionStreamCursor,
  frame: SessionStreamFrame,
): boolean {
  if (frame.channel === 'runtime') {
    const runtime = frame as SessionStreamRuntimeFrame;
    if (typeof runtime.epoch === 'string') cursor.epoch = runtime.epoch;
    // `kortix.hello`, `kortix.resync` and `kortix.heartbeat` carry no `seq`.
    // Advancing on them would make a gap check lie.
    if (typeof runtime.seq === 'number') {
      cursor.seq = runtime.seq;
      return true;
    }
    return false;
  }
  if (frame.channel === 'control') {
    const control = frame as SessionStreamControlFrame;
    if (typeof control.cepoch === 'string') cursor.cepoch = control.cepoch;
    if (typeof control.cseq === 'number') {
      cursor.cseq = control.cseq;
      return true;
    }
    return false;
  }
  return false;
}
