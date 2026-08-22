/**
 * Close an orphaned OpenCode turn from the CONTROL PLANE.
 *
 * A turn ends only when opencode emits `session.idle`/`session.error`. A killed
 * model call or a lost idle event emits neither, so the last assistant message
 * stays open on disk and every client streaming that root spins forever. The
 * daemon already knows how to clean this up — `finalizeOrphanedTurn`
 * (apps/kortix-sandbox-agent-server/src/main.ts:1217-1239) — but it runs that
 * ONLY on its own boot. A box that never restarts keeps its husk forever, and
 * the reaper meanwhile deletes the turn record that was the last evidence
 * anything was ever running. This module is the same finalize, reachable from
 * the reaper pass.
 *
 * `/kortix/abort` cannot be used per-turn: apps/kortix-sandbox-agent-server/
 * src/routes/abort.ts:29 resolves `readPinnedOpencodeSessionId()` and ignores
 * the session the caller asked about. It would abort the PINNED root, which is
 * a different root than a husk left by a secondary session. The abort here is
 * issued against the turn's own root through the OpenCode REST surface.
 *
 * THE ABORT IS ROOT-SCOPED, THE EVIDENCE IS MESSAGE-SCOPED. Every prompt of a
 * session runs on ONE OpenCode root (extractTurnIdentity reads it from the
 * request path), and `metadata.activeTurns` deliberately holds one record per
 * prompt, so a root can carry a husk AND a live turn at the same time. The
 * reaper's terminal observation is about ONE message: `opencodeDeliveryInFlight`
 * (opencode-turn-state.ts:188-193) answers false for a turn as soon as a newer
 * user message follows it. Aborting the root on that evidence would kill the
 * newer, live answer and stamp it "Interrupted". This module therefore aborts
 * only when the open assistant message is provably the answer to THIS record's
 * `messageId` (`info.parentID`), which is the same link the daemon uses.
 *
 * Never throws, and never fabricates: an unreadable transcript returns
 * 'unreadable' rather than terminal evidence, and the abort is only ever
 * reported as 'finalized' after a post-condition read finds THAT message and
 * sees it closed. "The target is no longer the last message" and "the root is
 * empty" are not that proof, and are reported 'unconfirmed'.
 *
 * Every read is tail-bounded (READ_MESSAGE_LIMIT) — this runs across the
 * provider ingress on a ~20s pass, not over localhost like the daemon's copy.
 *
 * WHY NOT `GET /session/status`? It exists in both 1.17.11 and 1.18.19 and it
 * is cheaper than a transcript read, but it answers a DIFFERENT question. Its
 * body is `{ [sessionID]: { type: 'idle' | 'busy' | 'retry' } }` — one verdict
 * per ROOT, with no message in it. This module is message-scoped by
 * construction (see the paragraph above): a root can hold a husk AND a live
 * turn at once, and `busy`/`idle` cannot say which of the two it is talking
 * about. Worse, the post-condition after the abort is the claim "THIS message
 * is now closed", and a root-level `idle` is exactly the reading that a
 * truncated or pushed-out target would also produce — the false 'finalized'
 * this module exists to avoid. `/session/status` would replace proof with a
 * guess, so the transcript read stays.
 */

import { resolveSandboxIngress, resolveServiceKey } from '../../sandbox-proxy/backend';
import {
  KORTIX_USER_CONTEXT_HEADER,
  encodeKortixUserContext,
} from '../../shared/kortix-user-context';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

export type HuskFinalizeOutcome = 'finalized' | 'not_husk' | 'unreadable' | 'unconfirmed';

export interface HuskFinalizeTarget {
  sandboxId: string;
  externalId: string;
  opencodeSessionId: string;
  /**
   * The client-minted user message THIS turn record owns
   * (StoredSandboxTurn.messageId). Without it no open assistant message on the
   * root can be attributed to this turn, and nothing is aborted.
   */
  messageId: string | null;
}

export interface HuskFinalizeOptions {
  /** Settle window between the two reads. Tests pass 0. */
  settleMs?: number;
}

/** The daemon's control port; the OpenCode REST surface is proxied behind it. */
const DAEMON_PORT = 8000;

/** The workspace every session's OpenCode root is opened against. */
const WORKSPACE = '/workspace';

/** Matches the daemon's own transcript read (opencode-turn-state.ts:76). */
const READ_TIMEOUT_MS = 5_000;

/**
 * How many TRAILING messages each read asks for.
 *
 * `/session/:id/message` returns every message together with its full `parts`
 * array — all tool output included — and `sandboxRuntimeRequestHeaders` forces
 * `Accept-Encoding: identity` (sandbox-fetch.ts:6-10), so an unbounded read
 * drags the entire conversation uncompressed across the provider ingress under
 * READ_TIMEOUT_MS, up to three times per husk, on every ~20s reaper pass. That
 * fails preferentially on long sessions — the exact population this module
 * exists for — and box-reaper.ts clears the record regardless, so the husk is
 * never closed and never retried. The daemon's own inspectRoot (main.ts:1612)
 * can afford the unbounded read: it runs over localhost inside the box, once
 * per boot.
 *
 * Four is the whole need: the target turn's assistant message, its user parent,
 * and one newer turn (user + assistant) that may land between the abort and the
 * post-condition read. Anything older than that window cannot be the root's
 * last message, so it can never be an abortable husk. Same `limit` param the
 * sibling readers send (session-transcript.ts:130).
 *
 * `limit` RETURNS THE TRAILING MESSAGES — verified, not assumed. `MessageV2.page`
 * in the pinned binary reads
 * `orderBy(desc(time_created), desc(id)).limit(limit + 1)`, slices to `limit`,
 * then `.reverse()`s, and its `before` cursor filters
 * `time_created < cursor OR (time_created = cursor AND id < cursor.id)` — i.e.
 * it pages BACKWARDS into history. So the window is the NEWEST `limit`
 * messages, handed back oldest-first. Checked against the 1.18.18 binary at
 * ~/.opencode/bin/opencode on 2026-08-20; the same code shape is present in
 * 1.17.11's generated SDK surface, whose `/session/{id}/message` query is the
 * identical `{directory?, limit?}`.
 *
 * The window is additionally a size bound only — `inspectRoot` reads positions
 * out of whatever list comes back, so a server that ignored `limit` would
 * change the transfer, not the verdict.
 */
const READ_MESSAGE_LIMIT = 4;

/** Matches the daemon's `abortOpencodeTurn` (main.ts:1695-1707). */
const ABORT_TIMEOUT_MS = 10_000;

/**
 * The daemon's `ORPHAN_SETTLE_MS` (main.ts:1608), for the same reason: an open
 * assistant message reads identically whether nobody is writing it or it is
 * about to complete. Waiting separates the two — nothing writes an orphan, so
 * it is still open a moment later, while a live turn has finished. Aborting
 * without this window ends healthy answers and labels them "Interrupted".
 */
const HUSK_SETTLE_MS = 2_000;

/**
 * Reach the box the same way `abortLiveTurnBeforeStop` (stop-box.ts:72-111)
 * does. `sandboxOpencodeEndpoint` is NOT reused: it resolves a preview user
 * context, which returns null without an actor user (shared/preview-ownership.ts:284),
 * so the signed header is omitted and the daemon's auth gate 401s every
 * non-`/kortix/*` path. The reaper has no actor user.
 */
async function resolveDaemonEndpoint(
  externalId: string,
  sandboxId: string,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  try {
    const serviceKey = await resolveServiceKey(externalId);
    if (!serviceKey) return null; // nothing to sign with — box has no key on record

    const ingress = await resolveSandboxIngress(externalId, {
      port: DAEMON_PORT,
      transport: 'http',
    });
    const headers: Record<string, string> = {
      ...ingress.headers,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      [KORTIX_USER_CONTEXT_HEADER]: encodeKortixUserContext(
        {
          userId: 'system:reaper',
          sandboxId,
          sandboxRole: 'platform_admin',
          scopes: ['*'],
        },
        serviceKey,
      ),
    };
    return { url: ingress.url.replace(/\/$/, ''), headers };
  } catch (err) {
    console.warn(
      `[husk-finalizer] endpoint unresolved for sandbox ${sandboxId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

interface HuskInspection {
  /** False when the read failed. "Could not tell" is never evidence. */
  known: boolean;
  /** An assistant message answering the TARGET user message is in the window. */
  targetFound: boolean;
  /** That message is still open by the daemon's predicate. */
  targetOpen: boolean;
  /** That message is the LAST on the root — nothing newer followed it. */
  targetIsLast: boolean;
  /** The root's last message, used to spot a newer turn across the two reads. */
  lastMessageId: string | null;
}

const UNKNOWN_INSPECTION: HuskInspection = {
  known: false,
  targetFound: false,
  targetOpen: false,
  targetIsLast: false,
  lastMessageId: null,
};

/**
 * The abort is ROOT-scoped, so it may only be issued while the target's open
 * assistant message is also the root's LAST message. A newer message on the
 * root means a newer turn may be streaming there, and aborting would end that
 * one and stamp it "Interrupted".
 */
function isAbortableHusk(inspection: HuskInspection): boolean {
  return inspection.targetFound && inspection.targetOpen && inspection.targetIsLast;
}

/**
 * Read the tail of the root and apply the DAEMON'S open-turn predicate, byte
 * for byte (apps/kortix-sandbox-agent-server/src/opencode-turn-state.ts:89-93),
 * to the assistant message that answers `messageId`. A retryable error is NOT a
 * closed turn — OpenCode still owns it.
 *
 * The predicate is TARGET-scoped, and the position is reported separately.
 * Judging the root's last message alone conflates three different facts: "the
 * target is closed", "the target is no longer last", and "the root is empty".
 * Only the first is evidence about this turn, and `finalizeHuskTurn` needs the
 * other two for opposite reasons — position gates the root-scoped abort, while
 * the post-condition needs the target itself.
 */
async function inspectRoot(
  endpoint: { url: string; headers: Record<string, string> },
  opencodeSessionId: string,
  messageId: string,
): Promise<HuskInspection> {
  try {
    const url = new URL(`${endpoint.url}/session/${encodeURIComponent(opencodeSessionId)}/message`);
    url.searchParams.set('directory', WORKSPACE);
    url.searchParams.set('limit', String(READ_MESSAGE_LIMIT));
    const res = await fetch(url, {
      headers: sandboxRuntimeRequestHeaders(endpoint.headers),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    // Non-2xx (opencode answering but unhappy — e.g. mid-restart) is a read
    // failure, not "no messages".
    if (!res.ok) return UNKNOWN_INSPECTION;
    const messages = (await res.json()) as Array<{
      info?: {
        id?: string;
        role?: string;
        parentID?: string;
        time?: { completed?: number };
        error?: { data?: { isRetryable?: boolean } };
      };
    }>;
    // An unparseable shape is also a read failure, not a genuinely empty root
    // — only an actual `[]` counts as a confirmed-empty root (main.ts:1618-1630).
    if (!Array.isArray(messages)) return UNKNOWN_INSPECTION;
    if (messages.length === 0) {
      return { ...UNKNOWN_INSPECTION, known: true };
    }
    const lastMessageId = messages[messages.length - 1]?.info?.id ?? null;
    // Search from the end: a retry or a revert can leave more than one
    // assistant under the same user message, and the newest one is the one
    // OpenCode is writing. (`findLastIndex` is ES2023; this tsconfig's lib is
    // older, and the lib floor is not this commit's to move.)
    let targetIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i]?.info;
      if (candidate?.role === 'assistant' && candidate?.parentID === messageId) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) {
      return { ...UNKNOWN_INSPECTION, known: true, lastMessageId };
    }
    const info = messages[targetIndex]?.info;
    const targetOpen = Boolean(
      !info?.time?.completed && (!info?.error || info.error.data?.isRetryable === true),
    );
    return {
      known: true,
      targetFound: true,
      targetOpen,
      targetIsLast: targetIndex === messages.length - 1,
      lastMessageId,
    };
  } catch {
    // Unreachable, or the read timeout fired — the same tri-state hazard the
    // daemon's own inspectRoot exists for.
    return UNKNOWN_INSPECTION;
  }
}

/**
 * Close one husk. The caller may act on the outcome:
 *   'finalized'   — the turn is provably closed now.
 *   'not_husk'    — nothing THIS turn owns is open (completed, errored, never
 *                   delivered, or the open message belongs to another turn).
 *   'unreadable'  — no evidence either way; do not treat as terminal.
 *   'unconfirmed' — the abort was issued but the turn still reads open.
 */
export async function finalizeHuskTurn(
  target: HuskFinalizeTarget,
  options?: HuskFinalizeOptions,
): Promise<HuskFinalizeOutcome> {
  const { sandboxId, externalId, opencodeSessionId, messageId } = target;
  // No message identity, no attribution. A `/command` or `/summarize` turn and
  // any pre-messageId record land here; aborting the root for them would be a
  // guess against a live turn, so they close the same way they did before this
  // module existed — they don't.
  if (!messageId) return 'not_husk';
  const endpoint = await resolveDaemonEndpoint(externalId, sandboxId);
  if (!endpoint) return 'unreadable';

  const first = await inspectRoot(endpoint, opencodeSessionId, messageId);
  if (!first.known) return 'unreadable';
  if (!isAbortableHusk(first)) return 'not_husk';

  await new Promise((resolve) => setTimeout(resolve, options?.settleMs ?? HUSK_SETTLE_MS));

  const second = await inspectRoot(endpoint, opencodeSessionId, messageId);
  // Never abort on the strength of the first read alone (main.ts:1667-1673).
  if (!second.known) return 'unreadable';
  if (!isAbortableHusk(second)) return 'not_husk'; // it finished, or a newer turn owns the root
  if (first.lastMessageId && second.lastMessageId !== first.lastMessageId) {
    return 'not_husk'; // a newer turn started, and that one is certainly alive
  }

  try {
    const res = await fetch(
      `${endpoint.url}/session/${encodeURIComponent(opencodeSessionId)}/abort?directory=${encodeURIComponent(WORKSPACE)}`,
      {
        method: 'POST',
        headers: endpoint.headers,
        signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.warn(`[husk-finalizer] abort declined for sandbox ${sandboxId}: ${res.status}`);
    }
  } catch (err) {
    console.warn(
      `[husk-finalizer] abort failed for sandbox ${sandboxId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // POST-CONDITION. The abort's own status is not the authority — the read is.
  // OpenCode's abort stamps `info.error` (AbortError/MessageAbortedError)
  // without `time.completed`; the predicate above reads that as closed because
  // the error carries no `data.isRetryable === true`.
  //
  // 'finalized' is a claim about ONE message, so the target must be SEEN closed.
  // A target that vanished from the window is not proof: a newer turn can push
  // it out, and a `session.revert` commit can truncate the root away entirely.
  // Both would otherwise be reported as a closure and the caller
  // (box-reaper.ts:227) deletes the record either way, so a wrong 'finalized'
  // is never retried and the husk stays open forever — the bug this module
  // exists to fix.
  const after = await inspectRoot(endpoint, opencodeSessionId, messageId);
  if (!after.known || !after.targetFound || after.targetOpen) return 'unconfirmed';
  console.info('[husk-finalizer] finalized orphaned turn', {
    sandboxId,
    opencodeSessionId,
    messageId,
  });
  return 'finalized';
}
