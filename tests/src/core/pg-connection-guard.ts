import { log } from './log';

/**
 * Survive a `pg` client whose server connection drops.
 *
 * `pg` rejects the in-flight query, then emits `'error'` on the client. The
 * flows open about 70 raw clients and most add no `'error'` listener, so that
 * event became an uncaught exception and exited the whole runner. Release gate
 * rehearsal 38278168762 (2026-10-12): staging dropped connections under three
 * concurrent gate runs, and `Connection terminated unexpectedly` killed API
 * shards 3, 4 and 6 mid-run, leaving about 250 flows unrun. The flow that
 * owned the client already failed on its rejected query; the stray event is
 * the only thing to absorb. Every other uncaught exception keeps the default:
 * print it and exit 1.
 */
const DROPPED = /^(Connection terminated unexpectedly|terminating connection due to administrator command)$/;

export function isDroppedPgConnection(err: unknown): boolean {
  return err instanceof Error && DROPPED.test(err.message);
}

export function installPgConnectionGuard(): void {
  process.on('uncaughtException', (err) => {
    if (isDroppedPgConnection(err)) {
      log.warn(`a database connection dropped (${err.message}); the flow that owned it fails on its query, the run continues`);
      return;
    }
    console.error(err);
    process.exit(1);
  });
}
