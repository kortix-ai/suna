import { describe, expect, test } from 'bun:test';

import { deliveryCountsAsActivity } from './delivery-activity';

/**
 * `metadata.last_activity_at` is what the sidebar sorts sessions by, and it was
 * written from exactly ONE place: the preview proxy, after its prompt dedupe
 * claim (`sandbox-proxy/routes/preview.ts`). That covers a prompt a BROWSER
 * sends.
 *
 * It does not cover a prompt the platform delivers itself — a coordinator
 * spawning a sub-session, a trigger firing, a channel message, an approval
 * resume. Those run through the lifecycle engine, which never touches the
 * proxy, so they never stamped anything.
 *
 * The consequence is the reported bug. `sessionLastActivityAt` falls through to
 * `project_sessions.updated_at` for a session with no activity record, and that
 * column is bookkeeping: the 60s sandbox heartbeat, the reaper, stuck-session
 * reconcile, runtime-identity recovery, branch GC telemetry and the trigger
 * access sweep all advance it with no turn behind them. So agent-spawned
 * sub-sessions — precisely the ones nested in the sidebar — sorted on a
 * timestamp that moves on its own, and visibly swapped places about once a
 * minute.
 *
 * `sessionLastActivityAt`'s own comment says step 3 "retires itself: any such
 * session gets an exact stamp on its next prompt". This is what makes that
 * true for a prompt the platform delivers.
 */
describe('deliveryCountsAsActivity', () => {
  test('a delivered prompt is a real turn — stamp it', () => {
    expect(deliveryCountsAsActivity('delivered')).toBe(true);
  });

  test('a prompt still in flight is not activity yet', () => {
    expect(deliveryCountsAsActivity('pending')).toBe(false);
  });

  test('a prompt that never reached the runtime is not activity', () => {
    expect(deliveryCountsAsActivity('unreachable')).toBe(false);
    expect(deliveryCountsAsActivity('no-session')).toBe(false);
    expect(deliveryCountsAsActivity('failed')).toBe(false);
  });

  test('accepted-then-never-written is NOT activity — the turn did not happen', () => {
    // `not-landed` means the runtime took the prompt and never wrote the
    // message. Stamping it would move the session up the sidebar for a turn
    // the user never sees.
    expect(deliveryCountsAsActivity('not-landed')).toBe(false);
  });
});
