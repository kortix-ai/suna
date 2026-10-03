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

type Handler = (projectId: string) => void;

let listener: postgres.Sql | null = null;
let handlers: Handler[] = [];
let publish: ((projectId: string) => void) | null = null;
let tunnelForwardHandler: ((payload: string) => void) | null = null;

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
    listener = sql;
    publish = (projectId: string) => {
      // Fire-and-forget on the LISTEN connection's own pool: it runs no other
      // statements, so a NOTIFY never queues behind request traffic. The caller
      // is inside the write that moved the branch and must not wait.
      void sql.notify(BASE_MOVE_CHANNEL, projectId).catch(() => {});
    };
    console.log(
      `[config-releases] base-move broadcast listening on ${BASE_MOVE_CHANNEL}, ${TUNNEL_FORWARD_CHANNEL}`,
    );
    return true;
  } catch (error) {
    // A transaction pooler multiplexes connections and cannot hold a LISTEN.
    // Say so once; the TTL is the backstop.
    console.warn(
      '[config-releases] base-move broadcast unavailable; the desired-release memo falls back to its TTL:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export async function stopConfigBaseMoveBroadcast(): Promise<void> {
  const sql = listener;
  listener = null;
  publish = null;
  handlers = [];
  if (!sql) return;
  await sql.end({ timeout: 2 }).catch(() => {});
}
