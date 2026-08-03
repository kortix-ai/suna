/**
 * The PURE half of the bounded-sandbox-lifetime rule: how long each kind of
 * observation is worth, and which observations count at all.
 *
 * No `db`, no provider adapters — so every classifier that decides whether a
 * box lives or dies can be exhaustively unit-tested without booting the
 * platform layer. The writers that turn these answers into one monotone SQL
 * statement live in ./sandbox-deadline.ts, which re-exports this surface so
 * call sites keep a single import.
 *
 * THE INVARIANT, restated once for the whole subsystem: a sandbox-reported
 * signal may only SHORTEN a box's life. Only a control-plane-OBSERVED event may
 * EXTEND it, and only up to a bounded ceiling.
 */

import { config } from '../config';
import { SESSION_DATA_PORTS } from '../sandbox-proxy/session-data-ports';
import { positiveEnvInt } from './reaper-constants';

/**
 * Absolute cap on ONE continuous running stretch, no matter how many turns it
 * contains and no matter what application bug exists. MIRRORS THE DB CHECK
 * (`session_sandboxes_deadline_within_cap`) — if you change this, change the
 * constraint in the same migration batch. At the cap the box is REFUSED new
 * work and parked; the next prompt wakes it into a fresh, freshly-anchored
 * stretch (see observeTurnStart).
 */
export const ABSOLUTE_RUN_CAP_MS = 24 * 3_600_000;

/**
 * Granted on every OBSERVED turn start.
 *
 * 4 hours sits above the p99 turn (~78 min, sessionised at a 5-minute
 * LLM-silence gap over 30 days of prod usage_events) and 66x below the observed
 * 264h worst case. It is NOT the whole answer for the tail — the MAX measured
 * turn is ~8.4h and roughly 7-18 turns per 30 days exceed 4h — which is what
 * `llmActivityGrantMs` exists to cover: every gateway LLM call mid-turn
 * re-extends the box, so a genuinely long turn keeps its box for as long as it
 * keeps talking to a model, bounded only by ABSOLUTE_RUN_CAP_MS.
 *
 * THE KNOWN GAP: a turn that makes NO gateway LLM call for four hours. That is
 * not a long turn — a long turn keeps talking to a model and keeps extending —
 * it is a BLOCKED one: the agent is waiting on a permission prompt or a
 * `question` the user has not answered. There is no observation for that today,
 * because the in-box relay that would report it (`relayQuestion` /
 * `relayTurnEndToApi` in kortix-sandbox-agent-server) returns early unless the
 * box has Slack context, so for a web session apps/api never learns a question is
 * pending. The browser's own traffic while the user reads the prompt lands on
 * port 8000/4096, which `isPreviewUseObservation` deliberately excludes. So a
 * prompt left unanswered for more than four hours loses its box, and with it the
 * in-flight turn (the box auto-resumes on the answer, but opencode restarts cold
 * and its pending question is gone). Ungating that relay — and giving the control
 * plane a real "a question is pending" observation — is the fix, and it is a
 * change to the sandbox agent, not to this file.
 *
 * KILL SWITCH: set KORTIX_SANDBOX_TURN_GRANT_MINUTES=100000 and every extend
 * out-runs the cap, so the LEAST clamps at active_since + 24h and the feature
 * is effectively neutralised without a rollback. That is also the mitigation for
 * the gap above if it turns out to bite real sessions before the relay lands.
 */
export function turnGrantMs(): number {
  return positiveEnvInt('KORTIX_SANDBOX_TURN_GRANT_MINUTES', 240) * 60_000;
}

/**
 * Granted on a gateway LLM call — the MID-TURN extension.
 *
 * `usage_events` is written by the gateway (apps/api/src/llm-gateway/hooks.ts)
 * after a real upstream completion, never by the sandbox, so it satisfies the
 * invariant: the box cannot mint one without spending real money through our
 * own control plane, and the resulting row IS the billing record.
 *
 * WHY IT MUST BE LARGE. Measured over 7 days of prod usage_events (n=53,441),
 * the gap between consecutive events inside one session is p50 0.13 min, p90
 * 0.70 min, p99 7.63 min — but p99.9 is over an hour, because a long local tool
 * run (build, test suite, migration) emits NO usage_events at all. A grant near
 * that p99.9 would kill a box in the middle of exactly the work it is there to
 * do, so this is deliberately ~4x it and equal to the turn grant: an LLM call is
 * every bit as strong an observation as a prompt POST.
 */
export function llmActivityGrantMs(): number {
  return positiveEnvInt('KORTIX_SANDBOX_LLM_ACTIVITY_GRANT_MINUTES', 240) * 60_000;
}

/**
 * Granted on authenticated HUMAN traffic to one of the box's own application
 * ports — the live preview / dev server.
 *
 * This is the fix for the regression the deadline model introduced: a user
 * clicking through the app their agent just built generates continuous
 * authenticated proxy traffic that the control plane watches end to end, and
 * without this the dev server died 15 minutes after the last AGENT turn while
 * the human was still using it. Such traffic is control-plane-OBSERVED and not
 * sandbox-authored, so it satisfies the invariant (see isPreviewUseObservation
 * for the three conditions).
 *
 * 30 minutes, not the 4-hour turn grant: a forgotten open tab that still polls
 * is the one plausible way to abuse this, and a shorter grant keeps the cost of
 * that bounded to ~30 minutes past the last real click. ABSOLUTE_RUN_CAP_MS
 * bounds it absolutely either way.
 */
export function previewGrantMs(): number {
  return positiveEnvInt('KORTIX_SANDBOX_PREVIEW_GRANT_MINUTES', 30) * 60_000;
}

/**
 * The whole lifetime of an UNCLAIMED warm-pool box.
 *
 * A warm box is baked speculatively so that session start feels instant. Until
 * somebody claims it, it has no turns, no LLM calls and no human traffic — so it
 * can NEVER receive an extend, and under the plain 20-minute boot floor every
 * warm box was reaped before it could be handed out, which defeats the feature
 * outright. It therefore gets its lifetime up front instead of by observation.
 *
 * 60 minutes is a deliberate ceiling, not an exemption: the exemption this
 * replaces was unbounded, and warm `available` boxes holding for hours were
 * measured as pure billed dead time. An hour covers "open the app, get
 * distracted, come back"; past that the box is waste and dies like anything else.
 */
export function warmPoolGrantMs(): number {
  return positiveEnvInt('KORTIX_SANDBOX_WARM_GRANT_MINUTES', 60) * 60_000;
}

/**
 * Granted on a sandbox-REPORTED terminal turn end: "die after 15 minutes of
 * inactivity". Reuses KORTIX_SANDBOX_AUTOSTOP_MINUTES, which is ALREADY 15 in
 * kortix-prod-env, so production needs no config change to get this behaviour.
 *
 * The sandbox agent relays root turn-end events for web, CLI, and channel
 * sessions. A Task-tool child cannot shorten the root sandbox deadline. The
 * deadline remains the bound if a sandbox loses callback access.
 */
export function idleGraceMs(): number {
  return Math.max(1, config.KORTIX_SANDBOX_AUTOSTOP_MINUTES || 15) * 60_000;
}

/**
 * Did the SANDBOX ITSELF author this request? Such a request may never extend
 * the box's deadline — that is the self-renewal this design deletes.
 *
 * Two credentials reach the control plane from inside a box, and BOTH must be
 * caught:
 *   - `kortix_sb_…`, the sandbox token, which sets apiKeyType 'sandbox';
 *   - a SESSION-SCOPED PAT (`kortix_pat_…`, injected as KORTIX_CLI_TOKEN /
 *     KORTIX_EXECUTOR_TOKEN and used by the in-box `kortix` CLI), whose auth
 *     branch never sets apiKeyType at all.
 * Testing apiKeyType alone therefore lets the box renew itself forever with its
 * own CLI token. A non-null session binding is the reliable signal: every
 * non-session-bound auth branch resolves sessionId to null.
 *
 * Single definition on purpose — the path-based and subdomain proxy edges once
 * carried divergent copies, and the weaker one failed open.
 */
export function isSandboxAuthored(
  apiKeyType: string | undefined | null,
  sessionId: string | undefined | null,
): boolean {
  return apiKeyType === 'sandbox' || (sessionId ?? null) !== null;
}

/** opencode's own port, and the in-box agent that reverse-proxies to it. */
const OPENCODE_PORT = 4096;
const AGENT_PORT = 8000;

/**
 * `/command` and `/summarize` are here because both start a real, billable turn
 * — a classifier admitting only prompt_async/message would kill a box mid
 * command. Do NOT reuse `isLongTurnCompletionRequest` from
 * sandbox-proxy/preview-retry-budget.ts: it matches only `/message` (every real
 * client uses prompt_async), and widening it would change that module's proxy
 * attempt-timeout behaviour.
 */
const TURN_START = /^\/session\/[^/]+\/(?:prompt_async|message|command|summarize)(?:$|[/?#])/;

/** Does this proxied request START a turn? Used by the proxy to observe a run
 *  beginning without trusting anything the sandbox says about itself. */
export function isTurnStartRequest(port: number, method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  if (port !== AGENT_PORT && port !== OPENCODE_PORT) return false;
  const p = path.replace(/^\/proxy\/\d+(?=\/)/, ''); // in-box dynamic-port nesting
  return TURN_START.test(p);
}

/**
 * Is this proxied request a HUMAN USING THE BOX'S PREVIEW, and therefore a
 * control-plane observation that the box is still wanted?
 *
 * All three conditions are load-bearing:
 *
 *  1. `isPrincipal` — an authenticated account member. A `public_share` forward
 *     carries no human credential we can attribute, and a share link the box
 *     itself fetches would be a self-renewal loop through the front door.
 *  2. `!sandboxAuthored` — the box holds two credentials that authenticate
 *     perfectly well (see isSandboxAuthored). Passive machine traffic the box
 *     originates must not count, or the deleted lease is rebuilt.
 *  3. NOT a session-data port. 8000/4096 carry the conversation, and their
 *     passive traffic — an open tab streaming events, repeated `/start` polls,
 *     background stream reconnects — is exactly what once kept idle boxes alive
 *     for days (verified live 2026-06-21: 1,597 phantom-active compute rows).
 *     A turn on those ports still extends the box, but through
 *     `isTurnStartRequest`, which requires a real prompt POST.
 *
 * Residual, stated honestly: a browser tab left open on a dev server that polls
 * on a timer keeps its box alive. That is bounded by `previewGrantMs` past the
 * last request and absolutely by ABSOLUTE_RUN_CAP_MS, and it is the same trade
 * every hosted preview makes — killing a dev server under an active user is the
 * worse failure.
 */
export function isPreviewUseObservation(opts: {
  isPrincipal: boolean;
  sandboxAuthored: boolean;
  upstreamPort: number;
}): boolean {
  if (!opts.isPrincipal) return false;
  if (opts.sandboxAuthored) return false;
  return !SESSION_DATA_PORTS.has(opts.upstreamPort);
}

/**
 * Did this sandbox-reported turn end TERMINATE the turn, or is opencode merely
 * about to try again?
 *
 * `session.error` fires for transient upstream failures too — a 429 rate-limit
 * backoff, a 5xx the provider will serve on retry — and opencode's own
 * `APIError.data.isRetryable` is the signal for exactly that. Treating a
 * retryable error as a turn end shortened the box to the 15-minute idle tail
 * WHILE THE TURN WAS STILL RUNNING, so a backoff longer than 15 minutes killed
 * the box mid-work. That is the one state the deleted execution lease got right:
 * it renewed while opencode reported 'busy' OR 'retry'.
 *
 * Only a turn we can see has genuinely finished may pull the deadline in:
 *   - status 'idle'                → opencode went quiet. Terminal.
 *   - status 'error', isRetryable false/undefined → a real failure. Terminal.
 *   - status 'error', isRetryable true            → a RETRY. Not terminal.
 *
 * `undefined` counts as terminal on purpose: an error carrying no retry flag is
 * an error, and defaulting the unknown case to "still running" would restore the
 * unbounded reprieve this whole change deletes.
 */
export function isTerminalTurnEnd(
  status: 'idle' | 'error',
  error?: { isRetryable?: boolean } | null,
): boolean {
  if (status !== 'error') return true;
  return error?.isRetryable !== true;
}

/**
 * Is this sandbox row an unclaimed WARM-POOL box?
 *
 * The warm marker is written onto `project_sessions.metadata.warm_session` by
 * the warm coordinator and forwarded verbatim into the sandbox row's own
 * metadata at provision (projects/lib/sessions.ts passes `input.metadata`
 * through to provisionSessionSandbox), so this needs no join. It is a SNAPSHOT
 * of the state at bake time and is never updated on claim — which is fine and
 * deliberate: a claimed box is extended by its first real turn, and the warm
 * grant it was born with is only ever a floor.
 */
export function isWarmPoolBox(metadata: Record<string, unknown> | null | undefined): boolean {
  const warm = metadata?.warm_session;
  if (!warm || typeof warm !== 'object' || Array.isArray(warm)) return false;
  return (warm as { state?: unknown }).state === 'available';
}

/**
 * A per-key minimum interval, so a chatty observation (a dev server serving 200
 * assets, a turn making 40 LLM calls) becomes at most one UPDATE per window
 * instead of 200.
 *
 * Correct to drop the extras because every extend is `GREATEST(deadline_at, now
 * + grant)`: within one window the second write would land on the same value the
 * first already produced. Deliberately NOT an LRU — see `sweep`.
 */
export function createExtendThrottle(intervalMs: number) {
  const nextAt = new Map<string, number>();
  return {
    /** True when this key may write now (and reserves the next window). */
    take(key: string, nowMs = Date.now()): boolean {
      if (nowMs < (nextAt.get(key) ?? 0)) return false;
      nextAt.set(key, nowMs + intervalMs);
      // Bounded memory without an eviction policy to get wrong: entries are
      // pure timestamps and expire by time, so a sweep on write is enough. A
      // long-lived pod otherwise accumulates one entry per sandbox forever.
      if (nextAt.size > 5_000) {
        for (const [k, at] of nextAt) if (at <= nowMs) nextAt.delete(k);
      }
      return true;
    },
    /** Test-only: forget every reservation. */
    reset(): void {
      nextAt.clear();
    },
  };
}
