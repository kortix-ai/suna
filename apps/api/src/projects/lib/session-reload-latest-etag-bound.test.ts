/**
 * The bound on `latestAgentConfigEtag`. KRTX-818: every deadline 503 on
 * `GET /v1/projects/:id/sessions/:id/config` had `git;dur` pinned at
 * 24.4–25.0s — the mirror fetch behind the etag stage has a 30s per-op timeout
 * and retries 3 times, so an unbounded wait always outran the 25s request
 * deadline. Bounded, the resolution answers `null` — the etag's designed
 * "could not tell", which every client of the route already handles — inside
 * the budget instead of a 503.
 *
 * The "dependency" is a local TCP listener that accepts the connection and
 * never answers: the resolution blocks on a real client connect that does not
 * settle within the budget. No mock sits between the function and the hang.
 */

// Set BEFORE the first import of the config/db modules. The port is bound
// below; the URL is rewritten once the listener is up.
const hangListener = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open(socket) {
      // Accept and stay silent: a dependency that took the connection and
      // answers nothing.
    },
    data() {},
    error() {},
    close() {},
  },
});
process.env.DATABASE_URL = `postgres://krtx818:krtx818@127.0.0.1:${hangListener.port}/krtx818_bound`;

import { describe, expect, test } from 'bun:test';

const { latestAgentConfigEtag } = await import('./session-reload');

const CALL = {
  projectId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  baseRef: 'main',
} as const;

/** Reject when `work` has not settled within `ms`, naming the failure mode. */
function unbounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const sentry = new Promise<never>((_, reject) => {
    giveUp = setTimeout(() => reject(new Error(`unbounded: not settled within ${ms}ms`)), ms);
  });
  return Promise.race([work, sentry]).finally(() => clearTimeout(giveUp!));
}

describe('latestAgentConfigEtag is bounded', () => {
  test('a resolution that cannot finish in its budget answers null', async () => {
    const started = Date.now();
    const result = await unbounded(latestAgentConfigEtag(CALL, { budgetMs: 250 }), 2_000);
    expect(result).toBeNull();
    // The budget, not the dependent client's own connect timeout, ended the
    // wait.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
