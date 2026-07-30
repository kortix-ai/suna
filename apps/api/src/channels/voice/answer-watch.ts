/**
 * Speaking a Kortix answer back into the call.
 *
 * The delivery half of Kortix→voice already works: `promptVoiceAgent` puts a
 * message on the call's LiveKit data channel and the worker turns it into
 * speech, no human utterance required. What was missing was anything to TRIGGER
 * it — so `ask_kortix` handed work to the session and the room waited forever.
 *
 * The obvious trigger would be the sandbox's own turn relay, but that relay is
 * gated on Slack env vars (`slackRelayContext` in
 * apps/kortix-sandbox-agent-server/src/main.ts — it returns null unless
 * SLACK_THREAD_TS/SLACK_CHANNEL_ID is set) and knows nothing about voice, so a
 * voice session's `step`/`answer`/`end` POSTs never leave the box. Fixing that
 * properly means changing the kortix-agent binary, which is BAKED INTO THE
 * SANDBOX IMAGE — a rebuild plus a rollout, and every sandbox that already
 * exists keeps the old binary regardless.
 *
 * So the API watches for the answer itself. There are two transports and the
 * watch reads whichever one the session actually runs on:
 *
 *  - **Managed ACP** (claude, codex, opencode, pi — all four, identically):
 *    `kortix.acp_session_envelopes`, in Postgres. No sandbox call at all.
 *  - **Legacy OpenCode REST**: the sandbox's own `/session/:id/message`, over
 *    the same signed proxy `opencode-mapping.ts` already uses.
 *
 * WHY ACP HAD TO BE ADDED, AND WHY IT WAS SILENT. This file used to be REST
 * only, and on a managed-ACP session that path cannot work for two independent
 * reasons. `project_sessions.opencode_session_id` holds the ACP SERVER id for an
 * ACP session (session-lifecycle/engine.ts:484 — `usesAcp ? acpServerId : …`),
 * so `GET /session/<acpServerId>/message` is a guaranteed 404; and the
 * in-sandbox OpenCode REST server is never started for managed ACP at all
 * (kortix-sandbox-agent-server/src/main.ts skips `opencode.start()`), so the
 * endpoint does not exist to be called. Every ACP voice ask therefore polled a
 * 404 for six minutes and then timed out, with the room hearing nothing. ACP is
 * the default transport, so that was every voice call.
 *
 * Transport is decided by `readManagedAcpSessionIdentity` on the session's
 * metadata — never by harness name, because all four harnesses use ACP the same
 * way — and no OpenCode pin is ever minted for an ACP session.
 *
 * Deliberately NOT on the request path: `askKortix` fires this and returns, so
 * the `ask_kortix` MCP tool still answers in milliseconds. Nothing here can
 * block a turn.
 */
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { loadAcpTranscript } from '../../projects/lib/acp-transcript';
import { sandboxOpencodeEndpoint } from '../../projects/opencode-mapping';
import { readManagedAcpSessionIdentity } from '../../projects/runtime-inspection';
import { sandboxRuntimeRequestHeaders } from '../../projects/sandbox-fetch';
import { db } from '../../shared/db';
import { acpSpokenAnswer, latestAcpTurnCompletion } from './acp-answer';
import { promptVoiceAgent, settleAsk } from './runtime';
import { kortixError, kortixResult } from './utterance';

/**
 * How long to wait for a turn before giving up. Agent turns can be minutes.
 *
 * Exported because ask-ledger.ts's `ASK_INFLIGHT_TIMEOUT_MS` has to sit just
 * PAST it: this watch settles the hand-off in a `finally`, so the ledger's own
 * expiry must only ever fire for a watch that died with its process, never for
 * one that is simply still waiting. unit-voice-ask-ledger.test.ts asserts the
 * ordering rather than trusting either comment.
 */
export const MAX_WAIT_MS = 6 * 60_000;
/** Gentle — one indexed read per tick, for one live call. */
const POLL_INTERVAL_MS = 2_500;
/** Long answers get truncated: this is going to be READ ALOUD. */
const MAX_SPOKEN_CHARS = 1_200;

/**
 * Poll cadence and budget. Production always uses {@link MAX_WAIT_MS} /
 * {@link POLL_INTERVAL_MS}; the parameter exists so answer-watch.test.ts can
 * prove the timeout path without waiting six minutes for it.
 */
export interface WatchTiming {
  maxWaitMs: number;
  pollIntervalMs: number;
}

const PRODUCTION_TIMING: WatchTiming = {
  maxWaitMs: MAX_WAIT_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
};

/* -------------------------------------------------------------------------- */
/* The two transports                                                         */
/* -------------------------------------------------------------------------- */

/** Where this session's turns can be read from. */
type AnswerSource =
  | { kind: 'acp'; projectId: string; sessionId: string; acpSessionId: string | null }
  | {
      kind: 'opencode';
      url: string;
      headers: Record<string, string>;
      opencodeSessionId: string;
    };

/**
 * The newest COMPLETED turn, in the one shape the poll loop understands.
 *
 * `id` is null when nothing has completed yet — a state the loop has to be able
 * to tell apart from a failed read, because one means "keep waiting" and the
 * other means "this watcher may be broken".
 */
interface TurnSnapshot {
  /** Stable identity of that turn. Never reused, never null once one exists. */
  id: string | null;
  /** The failure that turn ended with, if it failed. */
  error: string | null;
  /** What to read aloud, already truncated to {@link MAX_SPOKEN_CHARS}. */
  text: string;
}

/** One poll: either a snapshot, or the reason the read failed. */
type TurnRead = { snapshot: TurnSnapshot; error: null } | { snapshot: null; error: string };

const EMPTY_SNAPSHOT: TurnSnapshot = { id: null, error: null, text: '' };

function failedRead(err: unknown): TurnRead {
  return { snapshot: null, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Which transport, and everything needed to read it.
 *
 * ACP is checked FIRST and never falls through to the REST branch: an ACP
 * session's `opencode_session_id` is populated (with the ACP server id), so a
 * fallthrough would silently reinstate the 404-forever bug this function exists
 * to fix.
 */
async function resolveAnswerSource(sessionId: string): Promise<AnswerSource | null> {
  const [session] = await db
    .select({
      projectId: projectSessions.projectId,
      createdBy: projectSessions.createdBy,
      opencodeSessionId: projectSessions.opencodeSessionId,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!session) return null;

  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  if (readManagedAcpSessionIdentity(metadata)) {
    const acpSessionId =
      typeof metadata.acp_session_id === 'string' && metadata.acp_session_id.trim()
        ? metadata.acp_session_id
        : null;
    return { kind: 'acp', projectId: session.projectId, sessionId, acpSessionId };
  }

  if (!session.opencodeSessionId) return null;

  const [sandbox] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!sandbox?.externalId) return null;

  const endpoint = await sandboxOpencodeEndpoint(
    sandbox.externalId,
    session.createdBy ?? undefined,
  );
  if (!endpoint) return null;

  return { kind: 'opencode', ...endpoint, opencodeSessionId: session.opencodeSessionId };
}

async function readTurn(source: AnswerSource): Promise<TurnRead> {
  return source.kind === 'acp' ? readAcpTurn(source) : readOpencodeTurn(source);
}

/* -------------------------------------------------------------------------- */
/* ACP — the durable envelope log                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read the ACP turn from Postgres. No sandbox HTTP, no OpenCode pin, no branch
 * on which harness is running.
 *
 * Terminality comes from the `session/prompt` RESPONSE (see acp-answer.ts): the
 * harness's own "this turn is over" signal, persisted with its `stopReason`.
 * Growing text is not used as evidence, because every ACP delivery replays the
 * whole conversation first (`session/load`) and a replay of the previous answer
 * looks exactly like new text arriving.
 */
async function readAcpTurn(source: Extract<AnswerSource, { kind: 'acp' }>): Promise<TurnRead> {
  try {
    const envelopes = await loadAcpTranscript({
      projectId: source.projectId,
      sessionId: source.sessionId,
    });
    const completion = latestAcpTurnCompletion(envelopes);
    if (!completion) return { snapshot: EMPTY_SNAPSHOT, error: null };
    return {
      snapshot: {
        id: `acp:${completion.ordinal}`,
        error: completion.error,
        text: completion.error
          ? ''
          : acpSpokenAnswer(envelopes, completion, {
              acpSessionId: source.acpSessionId,
              maxChars: MAX_SPOKEN_CHARS,
            }),
      },
      error: null,
    };
  } catch (err) {
    return failedRead(err);
  }
}

/* -------------------------------------------------------------------------- */
/* OpenCode REST — legacy sessions, unchanged                                 */
/* -------------------------------------------------------------------------- */

interface OpencodeMessageLite {
  info?: {
    id?: string;
    role?: string;
    time?: { created?: number; completed?: number };
    /**
     * OpenCode nests the human-readable cause under `data`, e.g.
     * `{ name: 'APIError', data: { message: 'The "glm-5.2" model requires…' } }`.
     * `message` is kept as a fallback because not every error shape nests.
     * Reading only the top-level `message` yields undefined for the API errors
     * that actually occur, which made a failed turn indistinguishable from a
     * turn that simply had nothing to say.
     */
    error?: { name?: string; message?: string; data?: { message?: string } } | null;
  };
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>;
}

function errorMessage(message: OpencodeMessageLite): string | null {
  const error = message.info?.error;
  if (!error) return null;
  return error.data?.message ?? error.message ?? error.name ?? 'unknown error';
}

/** The spoken form of an assistant message: its plain text, nothing else.
 *  Reasoning and tool output are not for reading aloud. */
function spokenText(message: OpencodeMessageLite): string {
  const text = (message.parts ?? [])
    .filter((p) => p.type === 'text' && !p.synthetic && typeof p.text === 'string')
    .map((p) => (p.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return text.length > MAX_SPOKEN_CHARS ? `${text.slice(0, MAX_SPOKEN_CHARS)}…` : text;
}

function latestCompletedAssistant(messages: OpencodeMessageLite[]): OpencodeMessageLite | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.info?.role === 'assistant' && m.info.time?.completed) return m;
  }
  return null;
}

async function readOpencodeTurn(
  source: Extract<AnswerSource, { kind: 'opencode' }>,
): Promise<TurnRead> {
  try {
    const res = await fetch(
      `${source.url}/session/${encodeURIComponent(source.opencodeSessionId)}/message?limit=20`,
      {
        method: 'GET',
        // MUST go through this helper, not the raw endpoint headers: it sets
        // `Accept-Encoding: identity`. Without it the daemon replies compressed
        // and the fetch dies with a ZlibError — which, being caught below,
        // turned into an answer that simply never arrived and a watcher that
        // polled silently until its deadline.
        headers: sandboxRuntimeRequestHeaders(source.headers),
        // Generous on purpose: a sandbox that is resuming answers slowly, and
        // a timeout here is indistinguishable from "no answer yet" — it just
        // burns a poll. 5s was short enough to time out every tick while the
        // box was waking.
        signal: AbortSignal.timeout(15_000),
      },
    );
    // Reported as a failed READ, not as "no answer yet": a sandbox that is still
    // waking answers 502/503 here, and a watcher that only ever sees that needs
    // to be able to SAY so. Losing the status produced `lastError: null` — a
    // report that something failed, with no way to tell what.
    if (!res.ok) return { snapshot: null, error: `HTTP ${res.status}` };
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return { snapshot: null, error: 'malformed message list' };

    const message = latestCompletedAssistant(body as OpencodeMessageLite[]);
    if (!message) return { snapshot: EMPTY_SNAPSHOT, error: null };
    const failure = errorMessage(message);
    return {
      snapshot: {
        id: message.info?.id ?? null,
        error: failure,
        text: failure ? '' : spokenText(message),
      },
      error: null,
    };
  } catch (err) {
    // Sandbox blip — one bad tick is not a reason to abandon an answer that may
    // still be coming, so the caller keeps polling. But it COUNTS these: failing
    // every single tick is a broken watcher, not a blip, and must not stay
    // indistinguishable from "still thinking".
    return failedRead(err);
  }
}

/* -------------------------------------------------------------------------- */
/* The watch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every way this watch can end, in the words the transcript records.
 *
 * These are not decoration. This function owns the LIFETIME of one hand-off:
 * askKortix opens it (writing the ask row that blocks a second hand-off), and
 * whichever of these outcomes happens closes it. Anything that ends the watch
 * without naming an outcome would leave the call unable to hand anything over
 * until ask-ledger.ts's expiry catches it minutes later.
 */
type WatchOutcome = 'answered' | 'failed' | 'nothing to say' | 'session unreadable' | 'timed out';

/**
 * Wait for the session's next completed turn and speak it into the call.
 * Fire-and-forget: callers must NOT await this.
 *
 * The baseline turn is captured BEFORE the prompt is delivered so a turn that
 * was already sitting in history is never mistaken for the answer to this
 * request — the bug that would otherwise make the call read out a stale reply
 * instantly.
 *
 * The whole body runs inside a `try/finally` whose `finally` settles the ask.
 * That structure is load-bearing, not tidiness: the four `return`s below and the
 * loop's own deadline are five separate exits, and a hand-off that is never
 * settled costs the call its ability to ask again. If a new exit is added here,
 * it must produce a `WatchOutcome` on the way out.
 */
export function speakAnswerWhenReady(
  callId: string,
  sessionId: string,
  timing: WatchTiming = PRODUCTION_TIMING,
): void {
  void (async () => {
    let outcome: WatchOutcome = 'timed out';
    try {
      outcome = await watchForAnswer(callId, sessionId, timing);
    } catch (err) {
      console.error('[voice] answer watch crashed', { callId, sessionId }, err);
      outcome = 'session unreadable';
    } finally {
      await settleAsk(callId, outcome);
    }
  })();
}

export async function watchForAnswer(
  callId: string,
  sessionId: string,
  timing: WatchTiming = PRODUCTION_TIMING,
): Promise<WatchOutcome> {
  let source = await resolveAnswerSource(sessionId).catch((err) => {
    console.error('[voice] answer source lookup threw', { sessionId }, err);
    return null;
  });
  if (!source) {
    console.error('[voice] cannot watch for answer — no readable transport', { sessionId });
    return 'session unreadable';
  }

  const first = await readTurn(source);
  const baselineId = first.snapshot?.id ?? null;

  let consecutiveFailures = 0;
  let lastError = first.error;
  const deadline = Date.now() + timing.maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, timing.pollIntervalMs));

    const tick = await readTurn(source);
    if (!tick.snapshot) {
      lastError = tick.error;
      consecutiveFailures++;

      // Re-resolve rather than keep retrying with state that may be dead. The
      // OpenCode endpoint carries a SIGNED, sandbox-specific header, and
      // delivering the prompt is itself liable to resume or restart the sandbox
      // — which rotates that signature. Reusing the original headers then 401s
      // on every remaining poll, so the answer never arrives even though the
      // sandbox is healthy. For ACP it re-reads the row, which also picks up an
      // `acp_session_id` that was written after the watch started.
      if (consecutiveFailures % 4 === 0) {
        const refreshed = await resolveAnswerSource(sessionId).catch(() => null);
        if (refreshed) source = refreshed;
      }

      // ~30s of unbroken failure is not a blip — say so once, loudly, rather
      // than polling in silence until the deadline and reporting nothing.
      if (consecutiveFailures === 12) {
        console.error('[voice] answer watch cannot read the session', {
          sessionId,
          transport: source.kind,
          lastError,
        });
      }
      continue;
    }
    consecutiveFailures = 0;

    const snapshot = tick.snapshot;
    if (!snapshot.id || snapshot.id === baselineId) continue;

    if (snapshot.error) {
      await promptVoiceAgent(callId, kortixError(snapshot.error)).catch(() => {});
      return 'failed';
    }

    if (!snapshot.text) {
      // Not necessarily wrong — a turn can be all tool calls — but silence
      // here is indistinguishable from a broken watcher, and that ambiguity
      // cost hours once already.
      console.error('[voice] turn completed with nothing to say', {
        sessionId,
        turn: snapshot.id,
      });
      return 'nothing to say';
    }

    await promptVoiceAgent(callId, kortixResult(snapshot.text)).catch((err) =>
      console.error('[voice] failed to speak answer', err),
    );
    return 'answered';
  }

  console.error('[voice] gave up waiting for an answer', {
    sessionId,
    callId,
    transport: source.kind,
    lastError,
  });
  return 'timed out';
}
