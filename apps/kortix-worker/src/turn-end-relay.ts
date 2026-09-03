/**
 * Tell the control plane a pi turn ended.
 *
 * ## Why the worker has to do this
 *
 * The sandbox daemon already relays turn end, but it learns about it from
 * OpenCode's NATIVE event stream — `startOpencodeEventLoop` subscribes to
 * `${opencode.getInternalUrl()}/event` (`apps/kortix-sandbox-agent-server`).
 * The pi worker does not serve that surface: it serves the Kortix Runtime API
 * at `/kortix/opencode/*`. So on a pi session `onSessionIdle` never fires,
 * `relayTurnEndToApi` is never reached, and the turn row stays `active`.
 *
 * Measured on `pi.kortix.com`, 2026-08-29 — four sessions sampled live:
 * nine turn rows, **nine still `active`, zero ended**, the oldest 67 minutes
 * after its answer had been written. No turn on that environment had ever been
 * closed.
 *
 * The worker is the only process that knows when its own turn finished, so the
 * relay belongs here rather than in a watcher that would have to infer it.
 *
 * ## What an unclosed row costs
 *
 * - the transcript paints "Gathering thoughts…" over a finished turn until the
 *   runtime's own idle frame vetoes the stale read;
 * - `serverOpenTurnToken` stays non-null, so the composer holds `/` commands
 *   and shows Stop;
 * - `box-reaper` only clears an unobservable turn once `deadlineAt` passes —
 *   `KORTIX_SANDBOX_TURN_GRANT_MINUTES`, 240 by default — so the sandbox is
 *   held alive for hours after its work is done.
 *
 * That last one is why this retries instead of being best-effort, and why it
 * mirrors the daemon's retry rule exactly: stop on ANY ok response (apps/api
 * answering "already finalized" is an answer), retry only network/5xx.
 */

export type TurnEndStatus = 'idle' | 'error';

/** `POST /v1/projects/:projectId/turn-stream`, the route `r4.ts` serves. */
export function turnEndUrl(apiUrl: string, projectId: string): string {
  let rootEnd = apiUrl.length;
  while (rootEnd > 0 && apiUrl.charCodeAt(rootEnd - 1) === 47) rootEnd -= 1;
  const root = apiUrl.slice(0, rootEnd);
  return `${root}/projects/${encodeURIComponent(projectId)}/turn-stream`;
}

/**
 * The body `r4.ts` branches on: `kind` must be `end` or `turn_end`, and
 * `status` is read as `'error'` or "anything else means idle".
 *
 * `turn_end` rather than `end` — it is the alias newer sandboxes send, and the
 * one the API documents as carrying status plus the session id.
 */
export function turnEndPayload(input: {
  sessionId: string;
  status: TurnEndStatus;
  identity?: TurnEndIdentity | null;
}) {
  return {
    session_id: input.sessionId,
    kind: 'turn_end' as const,
    status: input.status,
    // Omitted when unknown rather than sent as null: `completeSandboxTurn`
    // branches on `IS NOT NULL`, and an explicit null is the same as absent.
    ...(input.identity?.opencodeSessionId
      ? { opencode_session_id: input.identity.opencodeSessionId }
      : {}),
    ...(input.identity?.messageId ? { turn_message_id: input.identity.messageId } : {}),
  };
}

/**
 * Which turn ended. Both fields come from the worker's own RuntimeSurface
 * (`turnEndIdentity()`), and both are REQUIRED for the row to actually close —
 * see that method for the two SQL branches that read them.
 *
 * Sending neither is why the first version of this relay closed nothing: on
 * pi.kortix.com 2026-08-30 a fresh session answered correctly, the relay POSTed
 * `turn_end`, apps/api answered 200, and the row stayed `active` — the
 * candidate set was empty because every pi turn stores a `ses_pi…` id and the
 * payload claimed none.
 */
export interface TurnEndIdentity {
  opencodeSessionId?: string | null;
  messageId?: string | null;
}

const MAX_ATTEMPTS = 4;

export interface TurnEndRelayConfig {
  apiUrl?: string;
  projectId?: string;
  sessionId?: string;
  kortixToken?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests, so the retry budget is exercised without sleeping. */
  waitMs?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Build the relay, or a no-op when the platform did not inject the wiring.
 *
 * The bench runs this worker with no control plane at all, so every field is
 * optional and their absence is an ordinary configuration, not an error. The
 * returned function NEVER throws and never rejects: a turn that produced a
 * correct answer must not be reported as failed because a bookkeeping call
 * could not be delivered.
 */
export function buildTurnEndRelay(
  cfg: TurnEndRelayConfig,
): (status: TurnEndStatus, identity?: TurnEndIdentity | null) => Promise<void> {
  const { apiUrl, projectId, sessionId, kortixToken } = cfg;
  if (!apiUrl || !projectId || !sessionId || !kortixToken) {
    return async () => {};
  }

  const doFetch = cfg.fetch ?? fetch;
  const wait = cfg.waitMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = cfg.log ?? ((line: string) => console.error(line));
  const url = turnEndUrl(apiUrl, projectId);

  return async (status: TurnEndStatus, identity?: TurnEndIdentity | null): Promise<void> => {
    const body = JSON.stringify(turnEndPayload({ sessionId, status, identity }));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${kortixToken}` },
          body,
        } as RequestInit);
        // Any ok response settles it — including apps/api saying the turn was
        // already finalized. Only a transport failure is worth retrying.
        if (res.ok) return;
        log(
          JSON.stringify({
            msg: 'turn-end relay non-ok',
            status: res.status,
            attempt,
          }),
        );
        return;
      } catch (error) {
        log(
          JSON.stringify({
            msg: 'turn-end relay failed',
            error: String((error as Error)?.message ?? error),
            attempt,
          }),
        );
      }
      if (attempt < MAX_ATTEMPTS) await wait(1_000 * attempt);
    }
    log(JSON.stringify({ msg: 'turn-end relay gave up', sessionId, status }));
  };
}

/**
 * Close a turn row a PREVIOUS worker process left open.
 *
 * `buildTurnEndRelay` fixes turns going forward and cannot touch a row that was
 * already stuck. On pi.kortix.com every session had one — nine rows across four
 * sessions, none ever closed — so re-entering any existing session still
 * painted "Gathering thoughts…" over a finished answer, with the composer stuck
 * on Stop. Those rows would otherwise sit until `deadlineAt`
 * (`KORTIX_SANDBOX_TURN_GRANT_MINUTES`, 240 by default).
 *
 * A worker boots whenever a parked session is opened, and at that instant it is
 * provably running no turn: `restoredMessages` is history read from the durable
 * store, not work in progress. So boot is exactly the moment to say "this
 * session is idle", and it lands the moment the user opens the session — which
 * is when they would otherwise see the stale shimmer.
 *
 * ## The race, and why the delay is the fix
 *
 * A prompt delivered immediately after boot starts a REAL turn whose row must
 * NOT be closed. Two guards, both required:
 *
 *  - `delayMs` — wait before firing, so a prompt already in flight gets to
 *    start its turn first;
 *  - `noteTurnStarted()` — the worker calls this the moment the agent begins
 *    work, and the reconcile then stands down permanently.
 *
 * Worst case if both are lost: one row is closed under a live turn. That is
 * self-correcting rather than sticky — `projectWorking`'s content-first rule
 * ranks the runtime's own streamed output above a `/turn` read, so a turn that
 * is really producing output keeps reading as working.
 */
export interface BootReconcile {
  /** Call when the agent starts a turn — cancels the reconcile for good. */
  noteTurnStarted(): void;
  /** Wait out the delay, then relay idle unless a turn started. Fires once. */
  run(): Promise<void>;
}

export function scheduleBootReconcile(input: {
  relay: (status: TurnEndStatus, identity?: TurnEndIdentity | null) => Promise<void>;
  /** Read at fire time — the surface exists by then, and boot is not a turn. */
  identity?: () => TurnEndIdentity | null;
  delayMs?: number;
  wait?: (ms: number) => Promise<void>;
}): BootReconcile {
  const delayMs = input.delayMs ?? 1_500;
  const wait = input.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let turnStarted = false;
  let fired = false;

  return {
    noteTurnStarted() {
      turnStarted = true;
    },
    async run() {
      if (fired) return;
      fired = true;
      await wait(delayMs);
      // Re-checked AFTER the wait, which is the whole point of waiting.
      if (turnStarted) return;
      await input.relay('idle', input.identity?.() ?? null);
    },
  };
}
