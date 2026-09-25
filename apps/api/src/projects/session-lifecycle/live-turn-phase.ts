import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

/**
 * What is the running turn DOING right now — writing text, running a tool, or
 * neither?
 *
 * Admission asks this for exactly one decision: a Quick Queue prompt typed over
 * a running response is normally STEERED into it, and a steer is only read at a
 * STEP boundary. A tool call ends a step every few seconds. A streamed markdown
 * answer is ONE step with no boundary anywhere inside it, so a steer forwarded
 * into it sat unread until the last character while the UI showed it as
 * working. Reported by the owner 2026-09-21: "tell me about pigeons", five
 * seconds in, "crow vs pigeon" — and the pigeon answer streamed to its end.
 * "The first prompt response should be stopped immediately. This is only
 * happening with the text response not with the tool call thing."
 *
 * REASONING STREAMS TOO (2026-09-22). DeepSeek V4.1 Flash, the default managed
 * model, wrote a whole 20-paragraph essay inside its REASONING part, and the
 * chat unfolds live reasoning, so the user watched it stream. This file read
 * `[step-start, reasoning]` as 'other', the Quick Queue prompt steered, and the
 * essay ran 2 min 43 s to `completed` with the prompt unread (owner report,
 * session 6f10c589). The owner's contract is "stop it when it is visibly
 * streaming", so an open reasoning part counts exactly like an open text part.
 *
 *   'text'  — the turn's newest step is open and is STREAMING: a text or a
 *             reasoning part is open, and the step has no tool call. Nothing
 *             will read a steer until the step ends; the response is ended
 *             instead. (The name is kept: it is the admission contract.)
 *   'tool'  — a tool is pending or running, whatever the reasoning state. Its
 *             end is a step boundary.
 *   'other' — between parts or steps, not started, already finished, or not
 *             readable. Steer, as before.
 *
 * THE TRADE-OFF, decided 2026-09-22. Reasoning also opens every TOOL step, and
 * while it streams the page cannot say whether a tool call follows. A prompt
 * typed then ends a step that might have gone on to call a tool. What that
 * loses is reasoning text, never work: no tool has started, so no file is
 * half-written — the daemon's own check refuses to abort while a tool runs.
 * The alternative left a visibly streaming response running for minutes.
 * A FINISHED reasoning part with nothing open after it stays 'other': that is
 * a gap of milliseconds before the next part opens, and nothing is streaming.
 * If a tool follows, the steer is read at that tool's end, as designed. If
 * text follows, a prompt that steered inside that gap is unread until the text
 * ends — the one residual window, left open because it is milliseconds wide
 * and every doubt resolves away from 'text'.
 *
 * Only 'text' ever ends anything, so EVERY doubt resolves away from it.
 */
export type LiveTurnPhase = 'text' | 'tool' | 'other';

/** Newest-N page, the same size the drain's placement read uses. The open step
 *  is by construction the newest assistant message, so the tip is enough — and
 *  a full read of a long session is megabytes and ~1s. */
export const LIVE_TURN_PHASE_PAGE_LIMIT = 8;
/** This read sits on the Enter key's critical path. Past this it steers (the
 *  fail-open answer). 2.5 s until 2026-09-22: the whole read is ~155 ms
 *  typically but was measured at 5.1 s on a loaded stack, so the bound fired,
 *  the prompt steered into a streaming essay, and sat unread for minutes. A
 *  late right answer costs a few seconds; an on-time wrong one costs the whole
 *  stream. The read holds only this session's lane: lanes of one drain run
 *  concurrently (`drain.ts`), each POST kicks its own targeted drain
 *  (`routes/session-prompts.ts`), and a drain already waits far longer for a cold box. */
export const LIVE_TURN_PHASE_READ_TIMEOUT_MS = 6_000;

const WORKSPACE = '/workspace';

interface PhaseMessage {
  info: { role?: unknown; parentID?: unknown; time?: { completed?: unknown } | null };
  parts: Array<{
    type?: unknown;
    text?: unknown;
    time?: { start?: unknown; end?: unknown } | null;
    state?: { status?: unknown } | null;
  }>;
}

function isPhaseMessage(value: unknown): value is PhaseMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as { info?: unknown; parts?: unknown };
  return !!message.info && typeof message.info === 'object' && Array.isArray(message.parts);
}

/**
 * Pure over one `GET /session/{id}/message` page. Shapes follow the daemon's
 * `quickQueueSnapshotFromPage` (`quick-queue-interrupt.ts`), which is the code
 * that acts on a 'text' answer — the two must agree on what a step is.
 */
export function liveTurnPhaseFromPage(page: unknown, turnMessageId: string): LiveTurnPhase {
  if (!turnMessageId || !Array.isArray(page)) return 'other';

  // The NEWEST step of this turn, and only if it is still open. A reverse scan,
  // not `findLast`: `apps/api` compiles at `target: ES2022`, where it does not
  // exist (see the same note in `quick-queue-interrupt.ts`).
  //
  // Steps parented on a DIFFERENT user message are not this turn's. That also
  // covers a turn that already took a steer: OpenCode parents each later step
  // on the newest user message, so they stop matching — and the daemon answers
  // `stale` for that turn anyway, so an interrupt armed against it would never
  // fire.
  let step: PhaseMessage | null = null;
  for (let i = page.length - 1; i >= 0; i -= 1) {
    const candidate: unknown = page[i];
    if (
      isPhaseMessage(candidate) &&
      candidate.info.role === 'assistant' &&
      candidate.info.parentID === turnMessageId
    ) {
      step = candidate;
      break;
    }
  }
  // A closed newest step is never overruled by an older one a crash left open.
  if (!step || step.info.time?.completed != null) return 'other';

  let tool = false;
  let toolLive = false;
  let streaming = false;
  for (const part of step.parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'tool') {
      tool = true;
      const status = part.state?.status;
      if (status === 'running' || status === 'pending') toolLive = true;
    } else if ((part.type === 'text' || part.type === 'reasoning') && part.time?.end == null) {
      // WRITTEN TO, OR OPENED. Reasoning follows the same lifecycle —
      // `reasoning-start` persists `{ text: '', time: { start } }` and only
      // `reasoning-end` writes the text and `time.end` (seen live 2026-09-22 on
      // DeepSeek: `reasoning(start, no end, 0 chars)` for the whole essay).
      // OpenCode 1.18 persists a text part at `text-start` as
      // `{ text: '', time: { start } }`, sends every
      // `text-delta` through `updatePartDelta` — which is
      // `publish(Event.PartDelta)` and no storage write (read from the 1.18
      // bundle, 2026-09-21) — and writes the text only at `text-end`, together
      // with `time.end`. So for the whole length of a streamed answer this
      // page shows an EMPTY text part with a start instant. Waiting for
      // characters would classify the exact case this exists for as 'other'.
      // A runtime that does persist as it streams shows the characters; both
      // count. So does the daemon's proxied transcript list, which adds the
      // text streamed so far to each open part (kortix-sandbox-agent-server
      // `open-part-text.ts`). An empty part with no start instant is evidence
      // of nothing.
      const written = typeof part.text === 'string' && part.text.trim().length > 0;
      const opened = typeof part.time?.start === 'number';
      if (written || opened) streaming = true;
    }
  }
  if (toolLive) return 'tool';
  // One assistant message is one step, and a tool call is what ends it. With a
  // finished tool in the open step the boundary a steer is read at is already
  // arriving — ending the turn there would discard its continuation for nothing.
  if (tool) return 'other';
  return streaming ? 'text' : 'other';
}

export interface LiveTurnPhaseReadDeps {
  /** The signed proxy endpoint + OpenCode root for the session
   *  (`resolveSessionOpencodeEndpoint` in `runtime-client.ts`). */
  resolveEndpoint: (
    sessionId: string,
    actorUserId?: string | null,
  ) => Promise<{
    endpoint: { url: string; headers: Record<string, string> };
    opencodeSessionId: string;
  } | null>;
  request?: (url: string, init: RequestInit) => Promise<Response>;
  /** The bound on the whole read. Tests only — `LIVE_TURN_PHASE_READ_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * One bounded read of the runtime, classified.
 *
 * FAILS OPEN to 'other' on every path that is not a parsed page of the turn
 * admission decided on: no endpoint, a root that moved on, a timeout, a non-2xx,
 * a body that is not JSON. 'other' steers, which is what happened before this
 * read existed. A read that did not happen must never end someone's response.
 *
 * THE BOUND COVERS THE WHOLE READ, not the GET alone. Endpoint resolution is
 * two database reads plus proxy signing and provider resolution, and the body
 * is read after the headers — an `AbortSignal.timeout` handed to `fetch` bounds
 * neither. The row is claimed for all of it, and the read repeats on every
 * admission attempt (300ms up to 2s apart) for as long as the text streams. So
 * one deadline races everything, and what it abandons is cancelled rather than
 * left open against the box.
 */
export async function readLiveTurnPhase(
  sessionId: string,
  active: { opencodeSessionId: string; messageId: string },
  actorUserId: string | null | undefined,
  deps: LiveTurnPhaseReadDeps,
): Promise<LiveTurnPhase> {
  const abandon = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<LiveTurnPhase>((resolve) => {
    deadline = setTimeout(() => {
      abandon.abort();
      resolve('other');
    }, deps.timeoutMs ?? LIVE_TURN_PHASE_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([timedOut, readPhase(sessionId, active, actorUserId, deps, abandon.signal)]);
  } catch {
    return 'other';
  } finally {
    clearTimeout(deadline);
  }
}

async function readPhase(
  sessionId: string,
  active: { opencodeSessionId: string; messageId: string },
  actorUserId: string | null | undefined,
  deps: LiveTurnPhaseReadDeps,
  signal: AbortSignal,
): Promise<LiveTurnPhase> {
  const resolved = await deps.resolveEndpoint(sessionId, actorUserId);
  if (signal.aborted) return 'other';
  if (!resolved || resolved.opencodeSessionId !== active.opencodeSessionId) return 'other';
  const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message?directory=${encodeURIComponent(WORKSPACE)}&limit=${LIVE_TURN_PHASE_PAGE_LIMIT}`;
  const response = await (deps.request ?? fetch)(url, {
    method: 'GET',
    headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
    signal,
  });
  if (!response.ok) return 'other';
  return liveTurnPhaseFromPage(await response.json(), active.messageId);
}
