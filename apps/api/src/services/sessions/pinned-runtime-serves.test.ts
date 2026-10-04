/**
 * A PINNED runtime that still serves must not have its session refused.
 *
 * `classifyDaemonHealth` returns `blocked` on one flag — `runtime.pinned ===
 * true` — set by the daemon's own supervisor after it tried an update, failed,
 * and rolled back. Never looping a repair on that is correct: another attempt
 * relaunches into the same rollback.
 *
 * But "do not REPAIR it" and "refuse the SESSION" were the same statement, and
 * the second does not follow. Measured on dev 2026-09-28, a pinned box:
 *
 *   daemon ok · opencode ok · runtimeReady true · uptime 14917s
 *   components: cli=current, skills=current, agent=skipped, opencode=current
 *   reasons:    {"agent": "updates pinned after a rollback"}
 *
 * Three of four components current, the box demonstrably serving — and the
 * open answered `stage: 'failed', retriable: false`, so no one could ever use
 * that session again and no retry could change it. A guaranteed total outage
 * traded against a possible degradation.
 *
 * This pins the SIGNAL the open reads to tell those two cases apart.
 */

import { describe, expect, test } from 'bun:test';

import { classifyDaemonHealth } from '../sandboxes/legacy-runtime-bootstrap';
import { pinnedRuntimeMayServe } from './pinned-runtime';

/** The measured dev box, verbatim in shape. */
const pinnedButServing = {
  daemon: 'ok',
  opencode: 'ok',
  runtimeReady: true,
  runtime: {
    build: 1790591344,
    pinned: true,
    components: { cli: 'current', skills: 'current', agent: 'skipped', opencode: 'current' },
    reasons: { agent: 'updates pinned after a rollback' },
  },
};

describe('a pinned runtime', () => {
  test('is classified blocked — the repair must never loop on it', () => {
    expect(classifyDaemonHealth(pinnedButServing).klass).toBe('blocked');
  });

  test('still reports it can serve, which is what the open must key on', () => {
    // `opencode: 'ok'` is the whole difference between "stale but usable" and
    // "cannot answer a prompt". The open refuses only the second.
    expect(classifyDaemonHealth(pinnedButServing).opencode).toBe('ok');
  });

  test('carries the operator detail, so nothing is silently swallowed', () => {
    const detail = classifyDaemonHealth(pinnedButServing).detail.join('; ');
    expect(detail).toContain('pinned');
  });

  test('the open PROCEEDS on it — the rule the route itself uses', () => {
    expect(pinnedRuntimeMayServe(classifyDaemonHealth(pinnedButServing))).toBe(true);
  });

  test('a pinned box that CANNOT serve is still distinguishable', () => {
    // The open must keep failing this one: blocked AND not serving.
    const dead = {
      ...pinnedButServing,
      opencode: 'starting',
      runtime: { ...pinnedButServing.runtime, components: { opencode: 'failed' } },
    };
    const c = classifyDaemonHealth(dead);
    expect(c.klass).toBe('blocked');
    expect(c.opencode).not.toBe('ok');
    // …and THIS one the open must still refuse.
    expect(pinnedRuntimeMayServe(c)).toBe(false);
  });

  test('a missing classification is refused, never waved through', () => {
    expect(pinnedRuntimeMayServe(null)).toBe(false);
    expect(pinnedRuntimeMayServe(undefined)).toBe(false);
    expect(pinnedRuntimeMayServe({ opencode: null })).toBe(false);
  });

  test('an unpinned healthy box is not blocked at all', () => {
    const healthy = {
      ...pinnedButServing,
      runtime: { ...pinnedButServing.runtime, pinned: false },
    };
    expect(classifyDaemonHealth(healthy).klass).not.toBe('blocked');
  });
});
