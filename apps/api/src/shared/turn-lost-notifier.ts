/**
 * Dependency-inverted hook: the box reaper settles a turn whose computer went
 * away (`runtime_gone`), and a background subagent's parent must hear about
 * it, or it waits for that child forever. The reaper's ledger
 * (projects/sandbox-turn-lifecycle.ts `clearSandboxTurn`) calls
 * `notifyTurnLost`; projects/subagent-notice.ts registers the relay, so the
 * lifecycle layer does not import the notice layer.
 *
 * Fire-and-forget: a relay failure never breaks the reaper.
 */
import { logger } from '../lib/logger';

type TurnLostNotifier = (sessionId: string, turnToken: string) => unknown;

// replica-local: each replica registers the same relays at startup; the reaper that settles a turn calls them in its own process.
const notifiers = new Set<TurnLostNotifier>();

/** Register a relay at startup. Registering the same function twice keeps one. Returns the remover. */
export function registerTurnLostNotifier(fn: TurnLostNotifier): () => void {
  notifiers.add(fn);
  return () => {
    notifiers.delete(fn);
  };
}

/** Tell every relay that `turnToken` of `sessionId` ended without its box. Never throws, never blocks. */
export function notifyTurnLost(sessionId: string, turnToken: string): void {
  for (const fn of notifiers) {
    try {
      void Promise.resolve(fn(sessionId, turnToken)).catch((err) =>
        logger.warn('[turn-lost-notifier] relay failed', { sessionId, error: err instanceof Error ? err.message : String(err) }),
      );
    } catch (err) {
      logger.warn('[turn-lost-notifier] relay failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
