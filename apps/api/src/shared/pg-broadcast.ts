/**
 * Telling every api process that a project's base branch moved.
 *
 * WHY THIS EXISTS. `turn-start-convergence.ts` memoizes the desired release per
 * `(project, base ref, agent, access, owner)` so a current box pays nothing on
 * the turn path. `notifyBaseBranchMoved` drops that memo — in the process that
 * handled the push. Dev runs two API pods behind one load balancer, so the
 * OTHER pod kept serving a release resolved before the push for up to
 * `DESIRED_TTL_MS`, and the gate answered `current` for a box that was behind.
 * That is DEF-DEV-1's enabling cause. Shortening the TTL narrows the window and
 * never closes it.
 *
 * WHY LISTEN/NOTIFY. The database is the one thing every api process already
 * holds a connection to, and the event is tiny, rare and idempotent — a dropped
 * one costs exactly one resolve. `pg_notify` from the writer is one statement
 * on the pool the write already used; the subscriber is one extra connection
 * per process, opened once.
 *
 * WHY A DEDICATED CONNECTION. `sql.listen()` takes a connection out of the pool
 * for the lifetime of the subscription. Taken from the request pool that is one
 * fewer connection for traffic, and a pool hiccup would take the subscription
 * with it. This opens its own `max: PG_BROADCAST_POOL_MAX` (1) client instead.
 * It is a long-lived, per-task connection: `database-capacity.ts` must count it
 * in the rolling-deployment ceiling (2026-09-27 incident — it didn't).
 *
 * IT IS AN OPTIMISATION, NEVER AN AUTHORITY. Every failure — a pooler that does
 * not speak LISTEN, a dropped connection, a malformed payload — degrades to the
 * behaviour before it existed: the local drop plus the TTL. Nothing here may
 * throw into a caller.
 */

import postgres from 'postgres';
import { config } from '../config';
import { PG_BROADCAST_POOL_MAX } from './database-capacity';
import { isUuid } from './validate';
import type { DesiredInvalidationTransport } from '../projects/lib/turn-start-convergence';

/** One channel, one event: "this project's base branch moved". */
export const BASE_MOVE_CHANNEL = 'kortix_config_base_moved';

/**
 * A second channel on the SAME connection: "a tunnel RPC forward row changed"
 * (`tunnel/core/cluster-forwarder.ts`). The payload is one id and nothing else:
 * the target replica's instance id for a new row, the request id for a result.
 * The writer sends it with `pg_notify` inside the statement that writes the
 * row, on the request pool, so this module opens no connection for it.
 */
export const TUNNEL_FORWARD_CHANNEL = 'kortix_tunnel_rpc_forward';

/**
 * A third channel: "this lifecycle command left `running`". A database trigger
 * (migration 20261003101600100) sends it for every writer, so the payload is
 * one command id. Waiters in this process wake on it; see
 * `waitForLifecycleCommandSettle`.
 */
export const LIFECYCLE_COMMAND_SETTLED_CHANNEL = 'kortix_lifecycle_command_settled';

/**
 * A fourth channel: "a lifecycle command is queued, due at this epoch ms". A
 * database trigger (migration 20261006135526223) sends it for every writer.
 * The drain worker schedules itself for that moment; see
 * `onLifecycleCommandDue`.
 */
export const LIFECYCLE_COMMAND_DUE_CHANNEL = 'kortix_lifecycle_command_due';

/**
 * A fifth channel: "this session's prompt inbox changed". A database trigger
 * (migration 20261006151556632) sends it for every writer of a
 * `continue_session` row, so the payload is one session id. The control
 * reconciler re-reads that session's queue now; see `onSessionPromptsChanged`.
 */
export const SESSION_PROMPTS_CHANGED_CHANNEL = 'kortix_session_prompts_changed';

/**
 * A sixth channel: "this session's box or title changed". Database triggers
 * (migration 20261006182246238) send it for every writer of a client-visible
 * `session_sandboxes` field (status, external id, live turns, wake fields) and
 * of the session title. The payload is one session id. The control reconciler
 * re-reads that session now, and `/events` streams waiting for a box wake; see
 * `onSessionChanged` and `waitForSessionChange`.
 */
export const SESSION_CHANGED_CHANNEL = 'kortix_session_changed';

type Handler = (projectId: string) => void;

let listener: postgres.Sql | null = null;
let handlers: Handler[] = [];
let publish: ((projectId: string) => void) | null = null;
let tunnelForwardHandler: ((payload: string) => void) | null = null;
let commandDueHandler: ((dueAtMs: number) => void) | null = null;
let promptsChangedHandler: ((sessionId: string) => void) | null = null;
// replica-local: subscribers in this process; the NOTIFY reaches every replica.
const sessionChangedHandlers = new Set<(sessionId: string) => void>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const LISTEN_RETRY_MS = 60_000;

// replica-local: a waiter waits in this process; the NOTIFY reaches every replica.
const settleWaiters = new Map<string, Set<() => void>>();

/**
 * Resolves when `commandId` leaves `running` (any replica's write) or after
 * `ms`, whichever is first. Register BEFORE reading the row: a settle that
 * lands between the read and the wait still wakes it. Without the LISTEN it is
 * a plain timer, so a caller passes its old poll interval then.
 */
export function waitForLifecycleCommandSettle(commandId: string, ms: number): { done: Promise<void>; cancel: () => void } {
  let wake = () => {};
  const done = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const waiters = settleWaiters.get(commandId) ?? new Set();
  settleWaiters.set(commandId, waiters);
  waiters.add(wake);
  const timer = setTimeout(wake, Math.max(0, ms));
  const cancel = () => {
    clearTimeout(timer);
    waiters.delete(wake);
    if (waiters.size === 0 && settleWaiters.get(commandId) === waiters) settleWaiters.delete(commandId);
    wake();
  };
  void done.then(cancel);
  return { done, cancel };
}

function wakeSettleWaiters(commandId: string): void {
  for (const wake of settleWaiters.get(commandId) ?? []) wake();
}

/** The drain worker registers on start. Kept across stop/start of the LISTEN. */
export function onLifecycleCommandDue(handler: ((dueAtMs: number) => void) | null): void {
  commandDueHandler = handler;
}

function deliverCommandDue(payload: string): void {
  const dueAtMs = Number(payload);
  if (!Number.isFinite(dueAtMs)) return;
  try {
    commandDueHandler?.(dueAtMs);
  } catch {
    // A subscriber must not take the listener down.
  }
}

/** The control reconciler registers once, at import. Kept across stop/start. */
export function onSessionPromptsChanged(handler: ((sessionId: string) => void) | null): void {
  promptsChangedHandler = handler;
}

function deliverPromptsChanged(payload: string): void {
  // The payload is a session id and nothing else.
  if (!isUuid(payload)) return;
  try {
    promptsChangedHandler?.(payload);
  } catch {
    // A subscriber must not take the listener down.
  }
}

/** Subscribe to `kortix_session_changed`. Returns the unsubscribe. Kept across stop/start. */
export function onSessionChanged(handler: (sessionId: string) => void): () => void {
  sessionChangedHandlers.add(handler);
  return () => {
    sessionChangedHandlers.delete(handler);
  };
}

/**
 * Resolves when `sessionId` changes (any replica's write), after `ms`, or when
 * `signal` aborts, whichever is first. Without the LISTEN it is a plain timer,
 * so a caller passes its pre-NOTIFY poll interval then.
 */
export function waitForSessionChange(sessionId: string, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const unsubscribe = onSessionChanged((changed) => {
      if (changed === sessionId) finish();
    });
    const timer = setTimeout(finish, Math.max(0, ms));
    (timer as unknown as { unref?: () => void }).unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

function deliverSessionChanged(payload: string): void {
  // The payload is a session id and nothing else.
  if (!isUuid(payload)) return;
  for (const handler of [...sessionChangedHandlers]) {
    try {
      handler(payload);
    } catch {
      // A subscriber must not take the listener down.
    }
  }
}

/** The forwarder registers once, at import. Kept across stop/start. */
export function onTunnelForwardNotify(handler: (payload: string) => void): void {
  tunnelForwardHandler = handler;
}

/**
 * True once this process holds the LISTEN. False means no NOTIFY can arrive
 * here, so a caller that waits on one must poll at its pre-NOTIFY rate.
 */
export function isPgBroadcastListening(): boolean {
  return listener !== null;
}

/**
 * The transport the invalidation is wired to. Subscribing before
 * `startConfigBaseMoveBroadcast` resolves is fine: handlers are held and fed by
 * whatever arrives after the LISTEN lands.
 */
export function configBaseMoveTransport(): DesiredInvalidationTransport {
  return {
    publish: (projectId) => publish?.(projectId),
    subscribe: (handler) => {
      handlers.push(handler);
    },
  };
}

function deliver(payload: string): void {
  // The payload is a project id and nothing else. Anything else on this channel
  // is not ours; dropping it costs a TTL window, acting on it would not.
  if (!isUuid(payload)) return;
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch {
      // A subscriber must not take the listener down.
    }
  }
}

/**
 * Open the subscription. Resolves once LISTEN is established, or once it is
 * known to be impossible — never rejects.
 *
 * Until it succeeds, `publish` is a no-op and every process falls back to its
 * local drop plus the TTL, which is exactly the behaviour that shipped before.
 */
export async function startConfigBaseMoveBroadcast(): Promise<boolean> {
  if (listener) return true;
  if (!config.DATABASE_URL) return false;
  try {
    const sql = postgres(config.DATABASE_URL, {
      max: PG_BROADCAST_POOL_MAX,
      // A subscription connection runs no statements of its own, so the
      // request pool's statement timeout would only be a way to lose it.
      idle_timeout: 0,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {},
    });
    // postgres.js re-issues the LISTEN itself when the connection drops and
    // comes back, so a database restart does not need handling here.
    await sql.listen(BASE_MOVE_CHANNEL, deliver);
    // `sql.listen` keeps one connection for every channel of this client.
    await sql.listen(TUNNEL_FORWARD_CHANNEL, (payload) => {
      try {
        tunnelForwardHandler?.(payload);
      } catch {
        // A subscriber must not take the listener down.
      }
    });
    await sql.listen(LIFECYCLE_COMMAND_SETTLED_CHANNEL, wakeSettleWaiters);
    await sql.listen(LIFECYCLE_COMMAND_DUE_CHANNEL, deliverCommandDue);
    await sql.listen(SESSION_PROMPTS_CHANGED_CHANNEL, deliverPromptsChanged);
    await sql.listen(SESSION_CHANGED_CHANNEL, deliverSessionChanged);
    listener = sql;
    publish = (projectId: string) => {
      // Fire-and-forget on the LISTEN connection's own pool: it runs no other
      // statements, so a NOTIFY never queues behind request traffic. The caller
      // is inside the write that moved the branch and must not wait.
      void sql.notify(BASE_MOVE_CHANNEL, projectId).catch(() => {});
    };
    console.log(
      `[config-releases] base-move broadcast listening on ${BASE_MOVE_CHANNEL}, ${TUNNEL_FORWARD_CHANNEL}, ${LIFECYCLE_COMMAND_SETTLED_CHANNEL}, ${LIFECYCLE_COMMAND_DUE_CHANNEL}, ${SESSION_PROMPTS_CHANGED_CHANNEL}, ${SESSION_CHANGED_CHANNEL}`,
    );
    return true;
  } catch (error) {
    // A transaction pooler multiplexes connections and cannot hold a LISTEN.
    // Say so once; the TTL is the backstop.
    console.warn(
      '[config-releases] base-move broadcast unavailable; the desired-release memo falls back to its TTL:',
      error instanceof Error ? error.message : String(error),
    );
    // Try again later. Until then every subscriber runs at its pre-NOTIFY rate.
    retryTimer ??= setTimeout(() => {
      retryTimer = null;
      void startConfigBaseMoveBroadcast();
    }, LISTEN_RETRY_MS);
    retryTimer.unref?.();
    return false;
  }
}

export async function stopConfigBaseMoveBroadcast(): Promise<void> {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const sql = listener;
  listener = null;
  publish = null;
  handlers = [];
  if (!sql) return;
  await sql.end({ timeout: 2 }).catch(() => {});
}
