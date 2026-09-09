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
 * stops on any ok response. Every non-ok response retains the durable marker
 * and consumes the bounded retry budget.
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
    ...(input.identity?.ownerId ? { turn_owner_id: input.identity.ownerId } : {}),
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
  ownerId?: string | null;
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
  /** Bound one HTTP attempt so a half-open socket cannot block the drain. */
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Build the relay, or a no-op when the platform did not inject the wiring.
 *
 * The bench runs this worker with no control plane at all, so every field is
 * optional and their absence is an ordinary configuration, not an error. The
 * returned function NEVER throws and never rejects: a turn that produced a
 * correct answer must not be reported as failed because a bookkeeping call
 * could not be delivered. The boolean reports whether the durable relay marker
 * can be cleared.
 */
export function buildTurnEndRelay(
  cfg: TurnEndRelayConfig,
): (status: TurnEndStatus, identity?: TurnEndIdentity | null) => Promise<boolean> {
  const { apiUrl, projectId, sessionId, kortixToken } = cfg;
  if (!apiUrl || !projectId || !sessionId || !kortixToken) {
    return async () => true;
  }

  const doFetch = cfg.fetch ?? fetch;
  const wait = cfg.waitMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = cfg.log ?? ((line: string) => console.error(line));
  const url = turnEndUrl(apiUrl, projectId);

  return async (status: TurnEndStatus, identity?: TurnEndIdentity | null): Promise<boolean> => {
    const body = JSON.stringify(turnEndPayload({ sessionId, status, identity }));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${kortixToken}` },
          body,
          signal: AbortSignal.timeout(Math.max(1, cfg.requestTimeoutMs ?? 10_000)),
        } as RequestInit);
        // Any ok response settles it — including apps/api saying the turn was
        // already finalized. A non-ok response proves no settlement, so keep
        // the durable marker and use the daemon's bounded retry rule.
        if (res.ok) return true;
        log(
          JSON.stringify({
            msg: 'turn-end relay non-ok',
            status: res.status,
            attempt,
          }),
        );
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
    return false;
  };
}

export interface PendingTurnEnd {
  messageId: string;
  status: TurnEndStatus;
}

export interface TurnEndRelayDrain {
  /** Start now, or coalesce with the attempt already in flight. */
  wake(): void;
  /** Cancel future retry timers. The attempt already in flight can finish. */
  close(): void;
}

/**
 * Keep durable terminal markers live until the control plane acknowledges them.
 * `buildTurnEndRelay` owns one bounded network budget. This drain owns the
 * longer process lifetime and retries that budget without requiring a restart.
 */
export function createTurnEndRelayDrain(input: {
  pending: () => PendingTurnEnd[];
  relay: (status: TurnEndStatus, identity?: TurnEndIdentity | null) => Promise<boolean>;
  markRelayed: (messageId: string) => Promise<unknown>;
  identity?: (messageId: string) => TurnEndIdentity;
  retryDelaysMs?: readonly number[];
  log?: (line: string) => void;
}): TurnEndRelayDrain {
  const delays = input.retryDelaysMs?.length ? input.retryDelaysMs : [1_000, 5_000, 15_000, 30_000];
  const log = input.log ?? ((line: string) => console.error(line));
  let retryIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let wakePending = false;
  let closed = false;

  const scheduleRetry = () => {
    if (closed || timer) return;
    const delay = delays[Math.min(retryIndex, delays.length - 1)]!;
    retryIndex += 1;
    timer = setTimeout(
      () => {
        timer = null;
        void drain();
      },
      Math.max(0, delay),
    );
  };

  const drain = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      wakePending = true;
      return;
    }
    running = true;
    let retry = false;
    let progressed = false;
    try {
      for (const turn of input.pending()) {
        const delivered = await input.relay(
          turn.status,
          input.identity?.(turn.messageId) ?? { messageId: turn.messageId },
        );
        if (!delivered) {
          retry = true;
          continue;
        }
        await input.markRelayed(turn.messageId);
        progressed = true;
      }
      if (input.pending().length > 0) retry = true;
    } catch (error) {
      retry = true;
      log(
        JSON.stringify({
          msg: 'turn-end relay drain failed',
          error: String((error as Error)?.message ?? error),
        }),
      );
    } finally {
      running = false;
      if (progressed) retryIndex = 0;
      if (wakePending) {
        wakePending = false;
        void drain();
      } else if (retry) {
        scheduleRetry();
      }
    }
  };

  return {
    wake() {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (running) {
        wakePending = true;
        return;
      }
      void drain();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
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
  relay: (status: TurnEndStatus, identity?: TurnEndIdentity | null) => Promise<unknown>;
  /** Exact historical turns to reconcile. Every candidate is attempted once. */
  candidates?: () => Array<{ status: TurnEndStatus; identity: TurnEndIdentity }>;
  /** A recovered started turn closes as error; ordinary stale rows close idle. */
  status?: () => TurnEndStatus;
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
      const candidates = input.candidates?.() ?? [];
      if (candidates.length > 0) {
        for (const candidate of candidates) {
          await input.relay(candidate.status, candidate.identity);
        }
        return;
      }
      await input.relay(input.status?.() ?? 'idle', input.identity?.() ?? null);
    },
  };
}
