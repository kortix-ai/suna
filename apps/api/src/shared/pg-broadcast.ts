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
 * with it. This opens its own `max: 1` client instead.
 *
 * IT IS AN OPTIMISATION, NEVER AN AUTHORITY. Every failure — a pooler that does
 * not speak LISTEN, a dropped connection, a malformed payload — degrades to the
 * behaviour before it existed: the local drop plus the TTL. Nothing here may
 * throw into a caller.
 */

import postgres from 'postgres';
import { config } from '../config';
import { isUuid } from './validate';
import type { DesiredInvalidationTransport } from '../projects/lib/turn-start-convergence';

/** One channel, one event: "this project's base branch moved". */
export const BASE_MOVE_CHANNEL = 'kortix_config_base_moved';

type Handler = (projectId: string) => void;

let listener: postgres.Sql | null = null;
let handlers: Handler[] = [];
let publish: ((projectId: string) => void) | null = null;

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
      max: 1,
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
    listener = sql;
    publish = (projectId: string) => {
      // Fire-and-forget on the LISTEN connection's own pool: it runs no other
      // statements, so a NOTIFY never queues behind request traffic. The caller
      // is inside the write that moved the branch and must not wait.
      void sql.notify(BASE_MOVE_CHANNEL, projectId).catch(() => {});
    };
    console.log(`[config-releases] base-move broadcast listening on ${BASE_MOVE_CHANNEL}`);
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
