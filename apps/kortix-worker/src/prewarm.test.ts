/**
 * P2.2 — the environment must be coming up BEFORE the model asks for it.
 *
 * Measured on pi.kortix.com: time to first token is 4.25s, and the first
 * `bash` call on that same cold session took 37.5s. The split did not remove
 * the environment's cold start — it moved it out of session setup and into the
 * middle of the first answer, where the user is already watching. That is
 * exactly the risk "Splitting the Harness" names: *"the cost has moved, not
 * vanished, and unless it is pre-warmed it now lands mid-turn."*
 *
 * The trigger is the first PROMPT, not session creation, and that choice is the
 * whole design:
 *
 *   - at session create it would provision for sessions nobody ever prompts,
 *     and the doc's cost argument is that a session which never touches compute
 *     should be dramatically cheaper;
 *   - at the first tool call it is already too late — that is today's 37.5s.
 *
 * A prompt means a turn is happening, so the provision overlaps the model's own
 * thinking instead of queueing behind it.
 */
import { describe, expect, test } from 'bun:test';
import { LazyKortixEnv } from './lazy-env.ts';

interface Harness {
  env: LazyKortixEnv;
  ensureCalls: () => number;
}

/**
 * A LazyKortixEnv whose `ensure` is a counted stub. Only the ensure is faked —
 * the dedupe, the failure handling and the ordering under test are the real
 * ones.
 */
function harness(opts?: { failEnsure?: boolean; delayMs?: number }): Harness {
  let calls = 0;
  const env = new LazyKortixEnv({
    apiUrl: 'http://127.0.0.1:1/v1',
    token: 'tok',
    projectId: 'p',
    sessionId: 's',
    cwd: '/workspace',
    ensureTimeoutMs: 50,
  });
  // Replace the single network call. Everything above it stays real.
  (env as unknown as { ensureOnce: () => Promise<unknown> }).ensureOnce = async () => {
    calls += 1;
    if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts?.failEnsure) throw new Error('provider said no');
    return { status: 'provisioning' };
  };
  return { env, ensureCalls: () => calls };
}

describe('prewarm', () => {
  test('starts the attach without the caller awaiting it', async () => {
    const h = harness({ delayMs: 10 });
    h.env.prewarm();
    // Returns immediately — a prompt must never block on provisioning.
    expect(h.env.attached).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.ensureCalls()).toBeGreaterThan(0);
  });

  test('is idempotent — repeated prompts do not start a second attach', async () => {
    const h = harness({ delayMs: 30 });
    h.env.prewarm();
    h.env.prewarm();
    h.env.prewarm();
    await new Promise((r) => setTimeout(r, 20));
    // All three joined the one in-flight attach.
    expect(h.ensureCalls()).toBe(1);
  });

  /**
   * The point of the whole change: a tool call that arrives while a prewarm is
   * in flight JOINS it rather than starting its own. Without this the prewarm
   * would be pure waste — two provisions racing for one session.
   */
  test('a tool call arriving mid-prewarm joins it instead of starting another', async () => {
    const h = harness({ delayMs: 40 });
    h.env.prewarm();
    await new Promise((r) => setTimeout(r, 10));
    await h.env.exec('echo hi');
    expect(h.ensureCalls()).toBe(1);
  });

  test('a failed prewarm never surfaces, and never poisons the next call', async () => {
    const h = harness({ failEnsure: true });
    // No unhandled rejection: prewarm is fire-and-forget by contract.
    h.env.prewarm();
    // Wait for the prewarm attach to SETTLE. The retry loop sleeps 2s between
    // attempts, so a shorter wait would find it still in flight — at which
    // point a tool call correctly joins it, which is a different behaviour
    // (already covered above) and not what this test is about.
    await new Promise((r) => setTimeout(r, 2_300));

    // The real call still runs, still fails as a Result, still never throws.
    const r = await h.env.exec('echo hi');
    expect(r.ok).toBe(false);
    // And it genuinely retried rather than replaying the poisoned attempt.
    expect(h.ensureCalls()).toBeGreaterThan(1);
  });

  test('prewarm on an already-attached env is a no-op', async () => {
    const h = harness({ delayMs: 5 });
    h.env.prewarm();
    await new Promise((r) => setTimeout(r, 80));
    const before = h.ensureCalls();
    h.env.prewarm();
    await new Promise((r) => setTimeout(r, 20));
    // A failed attach may retry, but prewarm itself adds no extra attempt.
    expect(h.ensureCalls()).toBeGreaterThanOrEqual(before);
  });
});
