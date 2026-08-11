/**
 * Speaking a dosco answer back into the call.
 *
 * The delivery half of dosco→voice already works: `promptVoiceAgent` puts a
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
 * So the API watches for the answer itself, over the same signed sandbox proxy
 * `opencode-mapping.ts` already uses to read a session's OpenCode state. That
 * works on sandboxes that exist TODAY and needs nothing rebuilt.
 *
 * Deliberately NOT on the request path: `askKortix` fires this and returns, so
 * the `ask_kortix` MCP tool still answers in milliseconds. Nothing here can
 * block a turn.
 */
import { eq } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { sandboxOpencodeEndpoint } from '../../projects/opencode-mapping';
import { sandboxRuntimeRequestHeaders } from '../../projects/sandbox-fetch';
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
/** Gentle — this is a sandbox round-trip per tick, for one live call. */
const POLL_INTERVAL_MS = 2_500;
/** Long answers get truncated: this is going to be READ ALOUD. */
const MAX_SPOKEN_CHARS = 1_200;

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

async function resolveOpencode(
  sessionId: string,
): Promise<{ url: string; headers: Record<string, string>; opencodeSessionId: string } | null> {
  const [session] = await db
    .select({
      createdBy: projectSessions.createdBy,
      opencodeSessionId: projectSessions.opencodeSessionId,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!session?.opencodeSessionId) return null;

  const [sandbox] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!sandbox?.externalId) return null;

  const endpoint = await sandboxOpencodeEndpoint(sandbox.externalId, session.createdBy ?? undefined);
  if (!endpoint) return null;

  return { ...endpoint, opencodeSessionId: session.opencodeSessionId };
}

async function fetchMessages(
  endpoint: { url: string; headers: Record<string, string>; opencodeSessionId: string },
): Promise<OpencodeMessageLite[] | null> {
  try {
    const res = await fetch(
      `${endpoint.url}/session/${encodeURIComponent(endpoint.opencodeSessionId)}/message?limit=20`,
      {
        method: 'GET',
        // MUST go through this helper, not the raw endpoint headers: it sets
        // `Accept-Encoding: identity`. Without it the daemon replies compressed
        // and the fetch dies with a ZlibError — which, being caught below,
        // turned into an answer that simply never arrived and a watcher that
        // polled silently until its deadline.
        headers: sandboxRuntimeRequestHeaders(endpoint.headers),
        // Generous on purpose: a sandbox that is resuming answers slowly, and
        // a timeout here is indistinguishable from "no answer yet" — it just
        // burns a poll. 5s was short enough to time out every tick while the
        // box was waking.
        signal: AbortSignal.timeout(15_000),
      },
    );
    // Thrown, not returned-null: a sandbox that is still waking answers 502/503
    // here, and a watcher that only ever sees that needs to be able to SAY so.
    // Returning null lost the status and produced `lastError: null` — a report
    // that something failed, with no way to tell what.
    if (!res.ok) throw new FetchTickError(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as OpencodeMessageLite[]) : null;
  } catch (err) {
    // Sandbox blip — one bad tick is not a reason to abandon an answer that may
    // still be coming, so this returns null and the caller keeps polling. But
    // the caller COUNTS these: failing every single tick is a broken watcher,
    // not a blip, and must not stay indistinguishable from "still thinking".
    throw new FetchTickError(err instanceof Error ? err.message : String(err));
  }
}

/** A single failed poll. Carries the cause so a watcher that never succeeds can
 *  say why instead of just timing out. */
class FetchTickError extends Error {}

async function tryFetchMessages(
  endpoint: { url: string; headers: Record<string, string>; opencodeSessionId: string },
): Promise<{ messages: OpencodeMessageLite[] | null; error: string | null }> {
  try {
    return { messages: await fetchMessages(endpoint), error: null };
  } catch (err) {
    return { messages: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function latestCompletedAssistantId(messages: OpencodeMessageLite[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.info?.role === 'assistant' && m.info.time?.completed) return m.info.id ?? null;
  }
  return null;
}

/**
 * Every way this watch can end, in the words the transcript records.
 *
 * These are not decoration. This function owns the LIFETIME of one hand-off:
 * askKortix opens it (writing the ask row that blocks a second hand-off), and
 * whichever of these outcomes happens closes it. Anything that ends the watch
 * without naming an outcome would leave the call unable to hand anything over
 * until ask-ledger.ts's expiry catches it minutes later.
 */
type WatchOutcome =
  | 'answered'
  | 'failed'
  | 'nothing to say'
  | 'session unreadable'
  | 'timed out';

/**
 * Wait for the session's next completed assistant turn and speak it into the
 * call. Fire-and-forget: callers must NOT await this.
 *
 * `baselineId` is captured BEFORE the prompt is delivered so a turn that was
 * already sitting in history is never mistaken for the answer to this request —
 * the bug that would otherwise make the call read out a stale reply instantly.
 *
 * The whole body runs inside a `try/finally` whose `finally` settles the ask.
 * That structure is load-bearing, not tidiness: the four `return`s below and the
 * loop's own deadline are five separate exits, and a hand-off that is never
 * settled costs the call its ability to ask again. If a new exit is added here,
 * it must produce a `WatchOutcome` on the way out.
 */
export function speakAnswerWhenReady(callId: string, sessionId: string): void {
  void (async () => {
    let outcome: WatchOutcome = 'timed out';
    try {
      outcome = await watchForAnswer(callId, sessionId);
    } catch (err) {
      console.error('[voice] answer watch crashed', { callId, sessionId }, err);
      outcome = 'session unreadable';
    } finally {
      await settleAsk(callId, outcome);
    }
  })();
}

async function watchForAnswer(callId: string, sessionId: string): Promise<WatchOutcome> {
  let endpoint = await resolveOpencode(sessionId);
  if (!endpoint) {
    console.error('[voice] cannot watch for answer — no opencode endpoint', { sessionId });
    return 'session unreadable';
  }

  const first = await tryFetchMessages(endpoint);
  const baselineId = first.messages ? latestCompletedAssistantId(first.messages) : null;

  let consecutiveFailures = 0;
  let lastError = first.error;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const tick = await tryFetchMessages(endpoint);
    const messages = tick.messages;
    if (!messages) {
      lastError = tick.error ?? lastError;
      consecutiveFailures++;

      // Re-resolve rather than keep retrying with credentials that may be
      // dead. The endpoint carries a SIGNED, sandbox-specific header, and
      // delivering the prompt is itself liable to resume or restart the
      // sandbox — which rotates that signature. Reusing the original headers
      // then 401s on every remaining poll, so the answer never arrives even
      // though the sandbox is healthy and answering other callers fine.
      if (consecutiveFailures % 4 === 0) {
        const refreshed = await resolveOpencode(sessionId);
        if (refreshed) endpoint = refreshed;
      }

      // ~30s of unbroken failure is not a blip — say so once, loudly, rather
      // than polling in silence until the deadline and reporting nothing.
      if (consecutiveFailures === 12) {
        console.error('[voice] answer watch cannot read the session', { sessionId, lastError });
      }
      continue;
    }
    consecutiveFailures = 0;

    const newestId = latestCompletedAssistantId(messages);
    if (!newestId || newestId === baselineId) continue;

    const message = messages.find((m) => m.info?.id === newestId);
    if (!message) continue;

    const failure = errorMessage(message);
    if (failure) {
      await promptVoiceAgent(callId, kortixError(failure)).catch(() => {});
      return 'failed';
    }

    const text = spokenText(message);
    if (!text) {
      // Not necessarily wrong — a turn can be all tool calls — but silence
      // here is indistinguishable from a broken watcher, and that ambiguity
      // cost hours once already.
      console.error('[voice] turn completed with nothing to say', { sessionId, id: newestId });
      return 'nothing to say';
    }

    await promptVoiceAgent(callId, kortixResult(text)).catch((err) =>
      console.error('[voice] failed to speak answer', err),
    );
    return 'answered';
  }

  console.error('[voice] gave up waiting for an answer', { sessionId, callId, lastError });
  return 'timed out';
}
