/**
 * Every read and write the session lifecycle makes against a session's runtime:
 * the OpenCode transcript, the daemon's Quick Queue control, the agent roster,
 * legacy message parts, and the prompt POST itself. Each call goes through the
 * session's signed proxy endpoint or `forwardToSandbox`, and each read fails
 * OPEN on its own terms.
 */

import { sessionAttachmentStore } from '../lib/session-attachments';
import { stableSessionAttachmentId } from '../lib/session-attachment-identity';
import { PromptDeliveryRefused, throwIfPromptRefused } from './prompt-delivery-refusal';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { WIRE_ID_PLACED_HEADER } from '../../sandbox-proxy/prompt-wire-id-repair';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { materializePromptAttachments } from './prompt-attachment-materializer';
import { writeRuntimePromptFile } from './runtime-prompt-file';
import {
  parseRuntimeAgentNames,
  resolveDeliverableAgent,
  runtimeAgentRoster,
} from './agent-availability';
import { forwardToSandbox } from '../../sandbox-proxy/routes/preview';
import { sandboxOpencodeEndpoint } from '../opencode-mapping';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { sendQuickQueueControl } from './quick-queue-control';
import { clearTurnStopRequest, markTurnStopRequested } from '../sandbox-turn-lifecycle';
import { db } from '../../shared/db';
import type { SessionLifecycleCommandRow, PromptOverridesWire, PromptPartWire } from './store';
import { type PlacementTipMessage, parsePlacementTip } from './forwarded-placement';
import { newestWireIdTime } from '../wire-message-id';
import type { LegacyRuntimeMessage } from './legacy-inline-attachment-repair';

const WORKSPACE = '/workspace';
export const DAEMON_PORT = 8000;

/**
 * The signed proxy endpoint + OpenCode root id for one session — the same
 * resolution every drain-side transcript read uses. Exported for the turn-end
 * reconciliation (`forwarded-strand-reconcile.ts`), which has a session, not a
 * row.
 */
export async function resolveSessionOpencodeEndpoint(
  sessionId: string | null | undefined,
  actorUserId?: string | null,
): Promise<{
  endpoint: { url: string; headers: Record<string, string> };
  opencodeSessionId: string;
} | null> {
  if (!sessionId) return null;
  const [session] = await db
    .select({
      opencodeSessionId: projectSessions.opencodeSessionId,
      sandboxUrl: projectSessions.sandboxUrl,
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      createdBy: projectSessions.createdBy,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!session?.opencodeSessionId) return null;

  let externalId = externalIdFromSandboxUrlField(session.sandboxUrl);
  if (!externalId) {
    const [sandbox] = await db
      .select({ externalId: sessionSandboxes.externalId })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sessionId, sessionId),
          eq(sessionSandboxes.projectId, session.projectId),
          eq(sessionSandboxes.accountId, session.accountId),
        ),
      )
      .orderBy(desc(sessionSandboxes.updatedAt))
      .limit(1);
    externalId = sandbox?.externalId ?? null;
  }
  if (!externalId) return null;

  // The signed user context is what the daemon admits a runtime read on
  // (`verifyKortixUserContext`); with no actor the call is refused as
  // `malformed`. A caller with no row of its own (turn-end reconciliation,
  // the stop settle) reads as the session's creator.
  const endpoint = await sandboxOpencodeEndpoint(
    externalId,
    actorUserId ?? session.createdBy ?? undefined,
  );
  if (!endpoint) return null;
  return { endpoint, opencodeSessionId: session.opencodeSessionId };
}

/** `sandboxUrl` on the session row looks like `.../p/<external_id>/8000/...`. */
function externalIdFromSandboxUrlField(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/p\/([^/]+)\//);
  return match?.[1] ?? null;
}

/** Cancel a pending boundary interrupt when its inbox prompt is removed. */
export async function disarmQuickQueueInterrupt(
  sessionId: string,
  actorUserId: string,
  promptId: string,
): Promise<void> {
  const resolved = await resolveSessionOpencodeEndpoint(sessionId, actorUserId).catch(() => null);
  if (!resolved) return;
  await sendQuickQueueControl(resolved.endpoint, { kind: 'disarm', promptId });
  // Only the head prompt arms an interrupt, so there is one mark to withdraw.
  await clearTurnStopRequest(sessionId, 'QueueInterrupt');
}

/** Stop holds all inbox rows, so no automatic boundary interrupt may remain. */
export async function disarmAllQuickQueueInterrupt(
  sessionId: string,
  actorUserId: string,
): Promise<void> {
  const resolved = await resolveSessionOpencodeEndpoint(sessionId, actorUserId).catch(() => null);
  if (!resolved) return;
  await sendQuickQueueControl(resolved.endpoint, { kind: 'disarm-all' });
  await clearTurnStopRequest(sessionId, 'QueueInterrupt');
}

export async function armQuickQueueInterrupt(
  row: SessionLifecycleCommandRow,
  identity: { opencodeSessionId: string; messageId: string },
): Promise<void> {
  const resolved = await resolveSessionOpencodeEndpoint(row.sessionId, row.actorUserId).catch(() => null);
  if (!resolved || resolved.opencodeSessionId !== identity.opencodeSessionId) return;
  const armed = await sendQuickQueueControl(resolved.endpoint, {
    kind: 'arm',
    promptId: row.commandId,
    opencodeSessionId: identity.opencodeSessionId,
    messageId: identity.messageId,
  });
  if (!armed) {
    logger.warn('[session-lifecycle] Quick Queue boundary interrupt unavailable', {
      sessionId: row.sessionId,
      commandId: row.commandId,
    });
    return;
  }
  // The daemon now aborts this turn at its next tool boundary because the user
  // sent a prompt into it. That abort is asked for, not a failure.
  if (!row.sessionId) return;
  await markTurnStopRequested(row.sessionId, 'QueueInterrupt', {
    opencodeSessionId: identity.opencodeSessionId,
    messageId: identity.messageId,
  });
}

/** What one read of the root transcript tells the drain about this prompt. */
export interface InboxTranscriptState {
  /** The highest id clock on record, for placing a re-mint above it. */
  newest: bigint | null;
  /** An assistant message answers one of this prompt's delivered ids, so the
   *  turn RAN. `false` also covers "could not read" — see `read`. */
  answered: boolean;
  /** The transcript was actually read. A failed read answers nothing. */
  read: boolean;
  /** The messages the read returned (newest tail), for placement proofs. */
  tip: PlacementTipMessage[] | null;
}

/** Newest-N read for placement. Only the tip decides where a re-mint lands,
 *  and a first delivery has no delivered id an `answered` check could match. */
const INBOX_TRANSCRIPT_TIP_LIMIT = 8;
/** A full read serves only the redelivery answered check. A long transcript
 *  with inline attachments is megabytes, so it gets more than the tip's 5s. */
const INBOX_TRANSCRIPT_FULL_READ_TIMEOUT_MS = 15_000;
const INBOX_TRANSCRIPT_TIP_READ_TIMEOUT_MS = 5_000;

/**
 * Read the root once, for the two things a delivery needs to know.
 *
 * Uses the SAME signed-proxy resolution `queuedContinueHasStagedRevert` uses —
 * no new client. Fails OPEN (`read: false`) on every error: a transient read
 * failure must never block a prompt, and every caller has its own safe default.
 */
export async function readInboxTranscriptState(
  row: SessionLifecycleCommandRow,
  deliveredIds: string[],
  opts: { full?: boolean } = {},
): Promise<InboxTranscriptState> {
  const empty: InboxTranscriptState = { newest: null, answered: false, read: false, tip: null };
  try {
    const resolved = await resolveSessionOpencodeEndpoint(row.sessionId, row.actorUserId);
    if (!resolved) return empty;
    // A FULL read only when this row has already been posted once (a
    // redelivery / re-POST), where the `answered` guard needs the reply that
    // may sit anywhere in the transcript. The ordinary case — a first delivery
    // placing its id above a live turn — needs the tip only, and the full read
    // of a long session was ~1s of dead air on every queued message.
    const limit = opts.full ? '' : `&limit=${INBOX_TRANSCRIPT_TIP_LIMIT}`;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message?directory=${encodeURIComponent(WORKSPACE)}${limit}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(
        opts.full ? INBOX_TRANSCRIPT_FULL_READ_TIMEOUT_MS : INBOX_TRANSCRIPT_TIP_READ_TIMEOUT_MS,
      ),
    });
    if (!res.ok) return empty;
    const tip = parsePlacementTip(await res.json().catch(() => null));
    if (!tip) return empty;

    const newest = newestWireIdTime(
      tip.map((message) => message.id),
      Date.now(),
    );
    // Same rule the daemon's `observeOpencodeDelivery` uses: an assistant
    // message parented on the prompt is the turn having run.
    const answered = tip.some(
      (message) =>
        message.role === 'assistant' &&
        typeof message.parentID === 'string' &&
        deliveredIds.includes(message.parentID),
    );
    return { newest, answered, read: true, tip };
  } catch (err) {
    console.warn('[session-lifecycle] inbox transcript read failed — proceeding without it', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

/**
 * Delete a stranded user message from the root transcript, so the re-placed
 * copy is the only one OpenCode — and the model — holds. `true` only on a
 * confirmed 2xx (or a 404: already gone).
 */
export async function removeStrandedOpencodeMessage(
  row: SessionLifecycleCommandRow,
  wireMessageId: string,
): Promise<boolean> {
  try {
    const resolved = await resolveSessionOpencodeEndpoint(row.sessionId, row.actorUserId);
    if (!resolved) return false;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message/${encodeURIComponent(wireMessageId)}?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok || res.status === 404) return true;
    // 409 = the loop is running (`assertNotBusy`); expected mid-turn.
    if (res.status !== 409) {
      console.warn('[session-lifecycle] stranded message delete refused', {
        sessionId: row.sessionId,
        commandId: row.commandId,
        status: res.status,
        body: (await res.text().catch(() => '')).slice(0, 200),
      });
    }
    return false;
  } catch (err) {
    console.warn('[session-lifecycle] stranded message delete threw', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * T22 — staged-revert guard for the queued `continue_session` backstop.
 *
 * OpenCode's `session.revert` is a STAGED pointer on the session row
 * (`Session.revert?: { messageID, ... }`, `@opencode-ai/sdk` `types.gen`).
 * Nothing is deleted until the NEXT prompt — from ANY producer — commits the
 * truncation. A queued continue (an approval "resume", a trigger fire) that
 * was enqueued BEFORE a user staged a revert must never be that committing
 * prompt: the user is mid-edit of their own session history, and an
 * automated continue queued against the pre-rewind trajectory is void once
 * the rewind lands. This is checked at DRAIN time (same reasoning as the
 * consumed-marker check above `executeQueuedContinue`) so a revert staged
 * after enqueue but before this row's turn to drain is still caught.
 *
 * Reuses `sandboxOpencodeEndpoint` (the same signed-proxy resolution
 * `session-transcript.ts` and `opencode-mapping.ts` already use — no new
 * client) to read the sandbox's live OpenCode session row. Any resolution
 * failure (no pin yet, sandbox unreachable, request timeout) fails OPEN —
 * returns false, i.e. delivers exactly as before this guard existed — so a
 * transient read failure never blocks a legitimate follow-up.
 */
export async function queuedContinueHasStagedRevert(row: SessionLifecycleCommandRow): Promise<boolean> {
  if (!row.sessionId) return false;
  try {
    const resolved = await resolveSessionOpencodeEndpoint(row.sessionId, row.actorUserId);
    if (!resolved) return false;
    const { endpoint, opencodeSessionId } = resolved;

    const url = `${endpoint.url}/session/${encodeURIComponent(opencodeSessionId)}?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const info = (await res.json().catch(() => null)) as { revert?: unknown } | null;
    return Boolean(info?.revert);
  } catch (err) {
    console.warn('[session-lifecycle] staged-revert check failed — proceeding as not staged', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The roster cache key. The directory is part of it because `/agent` answers a
 * DIFFERENT set per directory: a project-scoped agent exists only under the
 * directory that defines it. Keying on `externalId` alone made one box's
 * `/workspace` roster answer for every other directory on that box.
 */
export function runtimeAgentRosterCacheKey(externalId: string, directory: string): string {
  return `${externalId}::${directory}`;
}

/**
 * The agent names THIS session's runtime reports, cached per sandbox AND
 * directory.
 *
 * Read through the same signed proxy endpoint every drain-side transcript read
 * uses, so it inherits the session's own authentication and needs no second
 * credential path. Only called when a prompt actually names an agent — a send
 * with no pick costs nothing.
 */
async function sessionRuntimeAgentRoster(
  externalId: string,
  callerSessionId: string,
  actorUserId: string,
  /** The directory the prompt will be forwarded with. `/agent` answers a
   *  different set per directory, so reading the roster for `/workspace` while
   *  forwarding under another directory dropped valid project-scoped agents. */
  directory: string,
): Promise<{ names: readonly string[] | null }> {
  return runtimeAgentRoster(runtimeAgentRosterCacheKey(externalId, directory), async () => {
    const resolved = await resolveSessionOpencodeEndpoint(callerSessionId, actorUserId);
    if (!resolved) return null;
    const res = await fetch(
      `${resolved.endpoint.url}/agent?directory=${encodeURIComponent(directory)}`,
      {
        method: 'GET',
        headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) return null;
    return parseRuntimeAgentNames(await res.json().catch(() => null));
  });
}

interface LegacyRuntimePartTarget {
  externalId: string;
  opencodeSessionId: string;
  sessionId: string;
  userId: string;
}

function legacyRuntimeAccess(input: LegacyRuntimePartTarget) {
  return {
    kind: 'principal' as const,
    userId: input.userId,
    callerSessionId: input.sessionId,
    // Same server-to-server delivery rationale as `postPrompt`: this authenticates
    // as the account principal, not a session-bound agent token, so the caller
    // binding is null and the trigger-session manager override is preserved.
    boundCredentialSessionId: null,
    sandboxAuthored: false,
  };
}

/** Thrown out of `sendPrompt` when the runtime accepted a prompt and never
 *  wrote its message — see the landing-proof block in `continueSession`. */
export class PromptNeverLandedError extends Error {
  constructor(readonly wireMessageId: string | undefined) {
    super('prompt accepted but never became a message');
    this.name = 'PromptNeverLandedError';
  }
}

export async function readLegacyRuntimeMessage(
  input: LegacyRuntimePartTarget & { messageId: string },
): Promise<LegacyRuntimeMessage | null> {
  const response = await forwardToSandbox(
    input.externalId,
    DAEMON_PORT,
    legacyRuntimeAccess(input),
    'GET',
    `/session/${encodeURIComponent(input.opencodeSessionId)}/message/${encodeURIComponent(input.messageId)}`,
    `?directory=${encodeURIComponent(WORKSPACE)}`,
    new Headers(),
    undefined,
    config.KORTIX_URL ?? '',
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`legacy attachment message read failed (${response.status})`);
  }
  return (await response.json()) as LegacyRuntimeMessage;
}

export async function updateLegacyRuntimePart(
  input: LegacyRuntimePartTarget & { messageId: string; partId: string; text: string },
): Promise<void> {
  const body = new TextEncoder().encode(
    JSON.stringify({
      id: input.partId,
      sessionID: input.opencodeSessionId,
      messageID: input.messageId,
      type: 'text',
      text: input.text,
    }),
  );
  const response = await forwardToSandbox(
    input.externalId,
    DAEMON_PORT,
    legacyRuntimeAccess(input),
    'PATCH',
    `/session/${encodeURIComponent(input.opencodeSessionId)}/message/${encodeURIComponent(input.messageId)}/part/${encodeURIComponent(input.partId)}`,
    `?directory=${encodeURIComponent(WORKSPACE)}`,
    new Headers({ 'Content-Type': 'application/json' }),
    body.buffer as ArrayBuffer,
    config.KORTIX_URL ?? '',
  );
  if (!response.ok) {
    throw new Error(`legacy attachment part update failed (${response.status})`);
  }
}

/**
 * The wire `messageID` is SUPPLIED, never minted here.
 *
 * OpenCode orders its transcript by `time_created` then by the id's clock
 * prefix (`MessageV2.page()`, unchanged across 1.17.11 and 1.18.19), so an id
 * has to be placed above everything already on record. On a box running
 * opencode <= 1.18.14 that placement is also what decides "has this prompt
 * already been answered?" — the loop's exit check is an id compare there, and
 * a badly placed id means the turn never runs. From 1.18.15 the exit check is
 * `lastAssistant.parentID === lastUser.id`, so a bad id costs display order
 * rather than the turn. The process holding the transcript is the
 * one that can place it: the browser/CLI for a first delivery, and the
 * redelivery path here — which re-reads the transcript before it re-mints (see
 * `remintWireMessageId`). Every other producer (triggers, Slack, approval
 * resume) still sends no `messageID`, exactly as before, and gets a
 * root-scoped turn.
 *
 * F2: without a messageID, `prompt-dedupe.ts`'s precedence used to fall all
 * the way to its content-hash fallback — `sessionId` + `text` only. That is
 * sound across retries of ONE command (identical body by construction, see
 * `executeQueuedContinue`'s guarantee above), but unsound across TWO
 * different commands that happen to carry byte-identical text (two approvals
 * of one `actionPath`, a fixed-text trigger firing twice inside the TTL):
 * both hash to the SAME key, so the second is answered `200
 * {"deduplicated":true}` — which this function reads as delivered — and its
 * turn silently never runs. `idempotencyKey` closes this: it outranks the
 * content hash (`promptDeliveryKey`'s precedence, `prompt-dedupe.ts`), is
 * STABLE across every retry of one command (the caller passes the same value
 * every time — see `continueSession`), and is DISTINCT across different
 * commands even when their text matches exactly.
 */
export async function postPrompt(
  externalId: string,
  opencodeSessionId: string,
  text: string,
  userId: string,
  /** The session this prompt is FOR. Passed as the caller binding so the
   *  isolation guard proves the target matches, rather than being waived. */
  callerSessionId: string,
  /** F2: per-command identity forwarded as `Idempotency-Key` — see the note
   *  above. */
  idempotencyKey: string,
  /** The full prompt body + picks + wire id, when the producer supplied them. */
  prompt?: {
    parts?: PromptPartWire[];
    overrides?: PromptOverridesWire;
    wireMessageId?: string;
    materializationKey?: string;
    attachmentProjectId?: string;
    accountId?: string;
    projectId?: string;
  },
): Promise<'accepted' | 'deduplicated' | 'failed' | 'unreachable'> {
  const parts: PromptPartWire[] =
    prompt?.parts && prompt.parts.length > 0 ? prompt.parts : [{ type: 'text', text }];
  const deliverableParts = prompt?.materializationKey
    ? await materializePromptAttachments({
        parts,
        externalId,
        sessionId: callerSessionId,
        userId,
        accountId: prompt.accountId,
        projectId: prompt.projectId,
        materializationKey: prompt.materializationKey,
        writeFile: writeRuntimePromptFile,
        readAttachment: (scope) => sessionAttachmentStore().read(scope),
        saveAttachment: prompt.attachmentProjectId ? async (file) => {
          const saved = await sessionAttachmentStore().put({
            ...file,
            projectId: prompt.attachmentProjectId!,
            sessionId: callerSessionId,
            attachmentId: stableSessionAttachmentId(`${callerSessionId}:${prompt.materializationKey}:${file.index}`),
          });
          return saved.url;
        } : undefined,
      })
    : parts;
  const overrides = prompt?.overrides;
  // THE AGENT THE RUNTIME CAN ACTUALLY RUN — see `agent-availability.ts`.
  //
  // `prompt_async` answers 204 for an agent it does not have and then never
  // runs the turn, so forwarding an unknown name is the delivery loop reading
  // "delivered", retiring the inbox row, and the user's message ceasing to
  // exist. Dropping the name instead runs the prompt under the runtime's own
  // default, exactly as a send with no pick always has.
  const deliverableAgent = resolveDeliverableAgent(
    overrides?.agent ?? null,
    overrides?.agent
      ? await sessionRuntimeAgentRoster(
          externalId,
          callerSessionId,
          userId,
          // Same directory expression the forward uses at the bottom of this
          // function, so the roster read and the prompt forward always agree.
          overrides?.directory || WORKSPACE,
        )
      : { names: null },
  );
  if (deliverableAgent.dropped) {
    logger.warn('[session-lifecycle] dropped an agent the runtime does not have', {
      session_id: callerSessionId,
      requested_agent: overrides?.agent,
    });
  }
  const body = new TextEncoder().encode(
    JSON.stringify({
      ...(prompt?.wireMessageId ? { messageID: prompt.wireMessageId } : {}),
      parts: deliverableParts,
      ...(deliverableAgent.agent ? { agent: deliverableAgent.agent } : {}),
      ...(overrides?.model ? { model: overrides.model } : {}),
      ...(overrides?.variant ? { variant: overrides.variant } : {}),
    }),
  );
  try {
    const res = await forwardToSandbox(
      externalId,
      DAEMON_PORT,
      {
        kind: 'principal',
        userId,
        callerSessionId,
        // Server-to-server delivery acts as the account principal (userId), NOT
        // as a session-bound agent token. `boundCredentialSessionId` names the
        // CALLER's own agent/sandbox binding — null here, so the trigger-session
        // manager override in canAccessSandboxSession is NOT stripped from a
        // trigger-created session that a reuse-mode fire is re-prompting under
        // the account owner. Setting it to the target session id made every
        // trigger delivery 403 ("Not authorized to access this session") and
        // dead-letter as `delivery outcome: pending`.
        boundCredentialSessionId: null,
        sandboxAuthored: false,
      },
      'POST',
      `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
      // The producer's own directory when it named one, so a project-scoped
      // agent resolves the same way it does on a direct browser send.
      `?directory=${encodeURIComponent(overrides?.directory || WORKSPACE)}`,
      new Headers({
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        // The inbox placed this wire id against the transcript itself (see
        // `remintWireMessageId`), so the proxy's own placement read
        // (`prompt-wire-id-repair.ts`) has nothing to add — one fewer sandbox
        // round-trip per queued message. Direct clients never send this.
        ...(prompt?.wireMessageId ? { [WIRE_ID_PLACED_HEADER]: '1' } : {}),
      }),
      body.buffer as ArrayBuffer,
      config.KORTIX_URL ?? '',
    );
    if (res.ok || res.status === 204) {
      if (res.status === 200) {
        const result = (await res.json().catch(() => null)) as {
          deduplicated?: unknown;
        } | null;
        if (result?.deduplicated === true) return 'deduplicated';
      }
      return 'accepted';
    }
    await throwIfPromptRefused(res);
    if (res.status !== 404)
      console.warn('[session-lifecycle] prompt_async non-ok', { status: res.status });
    // 502/503/504 is the PROXY saying it could not reach the box (a dead
    // ingress, a control plane refusing the forward, an attempt that timed
    // out) — not the daemon refusing the prompt. Say so, so a spent deadline
    // parks the message on the runtime-unreachable ladder instead of spending
    // the dead-letter budget on a path that is simply down. See SendOutcome.
    if (res.status === 502 || res.status === 503 || res.status === 504) return 'unreachable';
    return 'failed';
  } catch (err) {
    if (err instanceof PromptDeliveryRefused) throw err;
    // A connection refused/reset while the sandbox finishes resuming — treat as a
    // retryable miss (the deliver loop will heal + retry) instead of letting it
    // bubble up and silently drop the turn.
    console.warn('[session-lifecycle] prompt_async threw (will retry)', { error: String(err) });
    // Connection refused/reset/timed out: the box is not reachable. Same
    // reasoning as the 502/503/504 branch above.
    return 'unreachable';
  }
}
