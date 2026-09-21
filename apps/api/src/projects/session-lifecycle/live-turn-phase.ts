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
 *   'text'  — the turn's newest step is open and a text part is being written,
 *             with no tool call in that step. Nothing will read a steer until
 *             the text is done; the response is ended instead.
 *   'tool'  — a tool is pending or running. Its end is a step boundary.
 *   'other' — reasoning, between steps, not started, already finished, or not
 *             readable. Steer, as before.
 *
 * Only 'text' ever ends anything, so EVERY doubt resolves away from it.
 */
export type LiveTurnPhase = 'text' | 'tool' | 'other';

/** Newest-N page, the same size the drain's placement read uses. The open step
 *  is by construction the newest assistant message, so the tip is enough — and
 *  a full read of a long session is megabytes and ~1s. */
export const LIVE_TURN_PHASE_PAGE_LIMIT = 8;
/** This read sits on the Enter key's critical path. Past this it is cheaper to
 *  steer (the fail-open answer) than to keep the prompt waiting. */
export const LIVE_TURN_PHASE_READ_TIMEOUT_MS = 2_500;

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
  let textOpen = false;
  for (const part of step.parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'tool') {
      tool = true;
      const status = part.state?.status;
      if (status === 'running' || status === 'pending') toolLive = true;
    } else if (part.type === 'text' && part.time?.end == null) {
      // WRITTEN TO, OR OPENED. OpenCode 1.18 persists a text part at
      // `text-start` as `{ text: '', time: { start } }`, sends every
      // `text-delta` through `updatePartDelta` — which is
      // `publish(Event.PartDelta)` and no storage write (read from the 1.18
      // bundle, 2026-09-21) — and writes the text only at `text-end`, together
      // with `time.end`. So for the whole length of a streamed answer this
      // page shows an EMPTY text part with a start instant. Waiting for
      // characters would classify the exact case this exists for as 'other'.
      // A runtime that does persist as it streams shows the characters; both
      // count. An empty part with no start instant is evidence of nothing.
      const written = typeof part.text === 'string' && part.text.trim().length > 0;
      const opened = typeof part.time?.start === 'number';
      if (written || opened) textOpen = true;
    }
  }
  if (toolLive) return 'tool';
  // One assistant message is one step, and a tool call is what ends it. With a
  // finished tool in the open step the boundary a steer is read at is already
  // arriving — ending the turn there would discard its continuation for nothing.
  if (tool) return 'other';
  return textOpen ? 'text' : 'other';
}

export interface LiveTurnPhaseReadDeps {
  /** The signed proxy endpoint + OpenCode root for the session
   *  (`resolveSessionOpencodeEndpoint` in `engine.ts`). */
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
