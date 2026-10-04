/**
 * Server-side placement of a prompt's wire `messageID` on the compat path.
 *
 * OpenCode answers "has this prompt already been answered?" by id ORDER: a
 * user message whose id sorts at-or-below the newest message on record is
 * accepted with 2xx and then silently never runs. The prompt inbox
 * (`POST .../prompts`) refuses an id it cannot verify and re-mints at delivery;
 * this is its sibling for every direct delivery through the sandbox proxy —
 * `/session/:id/prompt_async` and `/session/:id/message` for ANY target
 * session, CHILD sessions included, from any client (web sub-session view,
 * whitelabel, CLI, mobile).
 *
 * The 2026-08-18 SampleCo incident is the case: a steering prompt into a
 * spawned child session that was mid-turn. The tab's store held none of that
 * child's messages, so the client mint had nothing to lift against and fell
 * back to its 2-minute backdate; the id sorted below the child's streaming
 * tip; OpenCode read it as answered; the turn looped on; the bubble rendered
 * at the top of the thread. The client cannot know — only the box holds the
 * child's transcript. So the proxy asks the box.
 *
 * Repair, not refuse: on this path a dropped steer is the harm, and the caller
 * has already claimed its dedupe key against the ORIGINAL body (a retry still
 * dedupes). Repair only on POSITIVE evidence — a stale id against a read
 * transcript, or a malformed id. A failed read keeps the client's id: "we could
 * not check" is not "it is wrong". The effective id is echoed on the response
 * (`X-Kortix-Effective-Message-Id`) and written into the turn ledger identity,
 * so the daemon's exact-message probe and the reaper match the message that
 * actually exists.
 */

import { classifyRuntimeRequest } from './runtime-request';
import {
  WIRE_MESSAGE_ID,
  isWireIdAheadOf,
  mintWireMessageId,
  newestWireIdTime,
  wireIdClockDelta,
  wireIdTime,
} from '../sessions/wire-message-id';

/** Newest-N messages read before a delivery. Small on purpose: this sits on the
 *  delivery path of every direct send, and only the tip decides placement. */
export const PROMPT_TRANSCRIPT_READ_LIMIT = 8;
export const PROMPT_TRANSCRIPT_READ_TIMEOUT_MS = 4_000;
export const EFFECTIVE_MESSAGE_ID_HEADER = 'X-Kortix-Effective-Message-Id';
/** Sent by the inbox drain when it already placed the id against the
 *  transcript; the proxy then skips its own read. Stripped from the forward. */
export const WIRE_ID_PLACED_HEADER = 'X-Kortix-Wire-Id-Placed';

/**
 * Only OpenCode's two prompt routes need the proxy to place the id: a direct
 * client sends them. The Kortix prompt route is the API's own delivery, which
 * the inbox placed already.
 */
function promptRoute(path: string) {
  const request = classifyRuntimeRequest('POST', path);
  return request.kind === 'turn-start' && (request.verb === 'prompt_async' || request.verb === 'message')
    ? request
    : null;
}

export function isPromptWireIdRepairPath(path: string): boolean {
  return promptRoute(path) !== null;
}

/** The same session's newest-N read, with any `/proxy/<port>` prefix kept. */
export function promptTranscriptReadPath(path: string, limit: number): string {
  const route = promptRoute(path);
  if (!route) throw new Error(`not a prompt path: ${path}`);
  return `${route.prefix}/session/${encodeURIComponent(route.runtimeSessionId)}/message?limit=${limit}`;
}

export interface PromptWireIdRepairResult {
  body: ArrayBuffer;
  /** The id OpenCode will see: the client's, or the re-mint. Null when the body
   *  carried none (OpenCode mints its own). */
  effectiveMessageId: string | null;
  outcome: 'none' | 'kept' | 'reminted';
}

/** The client-minted `messageID` a prompt body carries, or null. Cheap peek so
 *  the caller only pays for a transcript read when there is an id to place —
 *  a body with none lets OpenCode mint, and no read can change that. */
export function promptBodyMessageId(body: ArrayBuffer | undefined): string | null {
  if (!body?.byteLength) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = (value as Record<string, unknown>).messageID;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/** Pure placement decision over an already-read transcript tip. */
export function repairPromptWireId(input: {
  body: ArrayBuffer | undefined;
  newestKnownTime: bigint | null;
  nowMs: number;
  random?: () => number;
}): PromptWireIdRepairResult {
  const body = input.body ?? new ArrayBuffer(0);
  const none: PromptWireIdRepairResult = { body, effectiveMessageId: null, outcome: 'none' };
  if (!body.byteLength) return none;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return none;
    parsed = value as Record<string, unknown>;
  } catch {
    return none;
  }
  const clientId = typeof parsed.messageID === 'string' ? parsed.messageID.trim() : '';
  if (!clientId) return none;

  const wellFormed = WIRE_MESSAGE_ID.test(clientId);
  const clientTime = wellFormed ? wireIdTime(clientId) : null;
  // At-or-below the newest on record, measured on the 48-bit ring: a pre-wrap
  // id is BELOW a post-wrap one although its number is larger.
  const stale =
    input.newestKnownTime !== null &&
    clientTime !== null &&
    wireIdClockDelta(clientTime, input.newestKnownTime) <= BigInt(0);
  // Positive evidence without any read: no transcript placed an id this far
  // ahead of the clock (the pre-fix CLI minted the HIGH bits, ~40 days out).
  const farAhead = wellFormed && isWireIdAheadOf(clientId, input.nowMs);
  if (wellFormed && !stale && !farAhead) {
    return { body, effectiveMessageId: clientId, outcome: 'kept' };
  }

  const minted = mintWireMessageId({
    nowMs: input.nowMs,
    newestKnownTime: input.newestKnownTime,
    random: input.random,
  });
  const rewritten = new TextEncoder().encode(JSON.stringify({ ...parsed, messageID: minted.id }));
  return {
    body: rewritten.buffer.slice(
      rewritten.byteOffset,
      rewritten.byteOffset + rewritten.byteLength,
    ) as ArrayBuffer,
    effectiveMessageId: minted.id,
    outcome: 'reminted',
  };
}

/**
 * One bounded read of the target session's newest messages. Fails OPEN
 * (`null`) on every error — the caller then keeps the client's id.
 */
export async function readNewestWireIdTime(input: {
  url: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<bigint | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(input.url, {
      method: 'GET',
      headers: input.headers,
      signal: AbortSignal.timeout(input.timeoutMs ?? PROMPT_TRANSCRIPT_READ_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const messages = (await res.json().catch(() => null)) as Array<{
      info?: { id?: unknown };
    }> | null;
    if (!Array.isArray(messages)) return null;
    return newestWireIdTime(
      messages.map((message) => (typeof message?.info?.id === 'string' ? message.info.id : null)),
      Date.now(),
    );
  } catch {
    return null;
  }
}
