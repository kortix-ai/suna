/**
 * The per-session audit ingest ceiling.
 *
 * The invariant these pin: a runaway session loses its per-token stream deltas
 * and NOTHING else, and the drop is announced exactly once per window. The
 * incident this guards against (release-gate run 32151213430) was one session
 * writing ~1725 `opencode.message.part.delta` rows/min into a 14-index table.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  applyOpenCodeAuditRateLimit,
  isSuppressibleStreamDelta,
  RATE_GUARD_SOURCE_LEDGER,
  SESSION_EVENT_RATE_LIMITED_ACTION,
  SUPPRESSED_ACTION_CLASS,
  __resetAuditRateGuardForTest,
  __trackedSessionCountForTest,
} from './opencode-audit-rate-guard';

const SCOPE = {
  accountId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
};

const WINDOW_MS = 60_000;
const T0 = 1_760_000_000_000;

/** A minimal parsed row — only the fields the guard reads. */
function evt(action: string) {
  return { action, resourceType: 'opencode_event' } as Parameters<
    typeof applyOpenCodeAuditRateLimit
  >[0]['values'][number];
}

function delta(n: number) {
  return Array.from({ length: n }, () => evt(SUPPRESSED_ACTION_CLASS));
}

function run(values: ReturnType<typeof evt>[], now: number, sessionId = SCOPE.sessionId) {
  return applyOpenCodeAuditRateLimit({ ...SCOPE, sessionId, values, now });
}

const ENV_KEYS = [
  'KORTIX_AUDIT_SESSION_EVENT_CEILING',
  'KORTIX_AUDIT_SESSION_WINDOW_MS',
  'KORTIX_AUDIT_SESSION_HOT_WINDOWS',
  'KORTIX_AUDIT_RATE_GUARD_MAX_SESSIONS',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.KORTIX_AUDIT_SESSION_EVENT_CEILING = '5';
  process.env.KORTIX_AUDIT_SESSION_WINDOW_MS = String(WINDOW_MS);
  __resetAuditRateGuardForTest();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key] as string;
  }
  __resetAuditRateGuardForTest();
});

describe('below the ceiling', () => {
  test('persists every event and announces nothing', () => {
    const result = run(delta(5), T0);

    expect(result.values).toHaveLength(5);
    expect(result.suppressed).toBe(0);
    expect(result.limited).toBe(false);
    expect(result.flagForReaper).toBe(false);
    expect(result.values.some((v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION)).toBe(false);
  });

  test('accumulates across batches inside one window', () => {
    run(delta(3), T0);
    const second = run(delta(2), T0 + 1_000);

    expect(second.suppressed).toBe(0);
    expect(second.limited).toBe(false);
  });
});

describe('above the ceiling', () => {
  test('drops the excess deltas and emits exactly one notice', () => {
    const result = run(delta(10), T0);

    // 5 under the ceiling survive, 5 are dropped, 1 notice is appended.
    expect(result.suppressed).toBe(5);
    expect(result.limited).toBe(true);
    expect(result.values).toHaveLength(6);

    const notices = result.values.filter((v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION);
    expect(notices).toHaveLength(1);
    expect(result.values.filter((v) => v.action === SUPPRESSED_ACTION_CLASS)).toHaveLength(5);
  });

  test('the notice carries the counts that justify it', () => {
    const notice = run(delta(10), T0).values.find(
      (v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION,
    );

    expect(notice).toBeDefined();
    const metadata = notice?.metadata as Record<string, unknown>;
    expect(metadata.ceiling).toBe(5);
    expect(metadata.window_ms).toBe(WINDOW_MS);
    expect(metadata.observed_events).toBe(10);
    expect(metadata.consecutive_hot_windows).toBe(1);
    expect(metadata.suppressed_action_class).toBe(SUPPRESSED_ACTION_CLASS);
    expect(notice?.sessionId).toBe(SCOPE.sessionId);
    expect(notice?.accountId).toBe(SCOPE.accountId);
    expect(notice?.outcome).toBe('denied');
    expect(notice?.actorType).toBe('system');
  });

  test('the notice dedupes per window, so a relay retry cannot multiply it', () => {
    const notice = run(delta(10), T0).values.find(
      (v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION,
    );
    const expected = createHash('sha256').update(`${SCOPE.sessionId}:${T0}`).digest('hex');

    expect(notice?.sourceLedger).toBe(RATE_GUARD_SOURCE_LEDGER);
    expect(notice?.sourceRecordId).toBe(expected);
  });

  test('announces once per window, not once per batch', () => {
    const first = run(delta(10), T0);
    const second = run(delta(10), T0 + 1_000);
    const third = run(delta(10), T0 + 2_000);

    expect(first.values.filter((v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION)).toHaveLength(1);
    expect(second.values.filter((v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION)).toHaveLength(0);
    expect(third.values.filter((v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION)).toHaveLength(0);
    // Suppression keeps working after the announcement.
    expect(second.suppressed).toBe(10);
    expect(third.suppressed).toBe(10);
  });

  test('counts dropped events toward the observed rate', () => {
    run(delta(10), T0);
    const notice = run(delta(10), T0 + 1_000).values.find(
      (v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION,
    );
    // No second notice this window; the running count is still advancing.
    expect(notice).toBeUndefined();

    const later = run(delta(1), T0 + 2_000);
    expect(later.limited).toBe(true);
  });

  test('each session gets its own budget', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    run(delta(10), T0);
    const clean = run(delta(3), T0, other);

    expect(clean.suppressed).toBe(0);
    expect(clean.limited).toBe(false);
  });
});

describe('what may never be dropped', () => {
  test('lifecycle, tool and permission events survive far over the ceiling', () => {
    const keepers = [
      'opencode.session.idle',
      'opencode.tool.updated',
      'opencode.permission.updated',
      'opencode.message.part.text.updated',
      'opencode.session.error',
      'session.usage.recorded',
    ];
    const result = run([...delta(20), ...keepers.map(evt)], T0);

    for (const action of keepers) {
      expect(result.values.filter((v) => v.action === action)).toHaveLength(1);
    }
    // Only the delta class was ever dropped.
    expect(result.suppressed).toBe(15);
  });

  test('a session made entirely of non-delta events is never suppressed', () => {
    const result = run(
      Array.from({ length: 50 }, (_, i) => evt(`opencode.tool.updated.${i % 3}`)),
      T0,
    );

    expect(result.suppressed).toBe(0);
    expect(result.values.filter((v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION)).toHaveLength(1);
    // The window is still marked hot — the rate is real even when nothing is droppable.
    expect(result.limited).toBe(true);
  });

  test('the suppressible class is pinned to per-token deltas', () => {
    expect(isSuppressibleStreamDelta('opencode.message.part.delta')).toBe(true);
    expect(isSuppressibleStreamDelta('opencode.message.part.delta.text')).toBe(true);
    expect(isSuppressibleStreamDelta('opencode.message.part.text.updated')).toBe(false);
    expect(isSuppressibleStreamDelta('opencode.tool.updated')).toBe(false);
    expect(isSuppressibleStreamDelta('opencode.session.idle')).toBe(false);
    expect(isSuppressibleStreamDelta('account.member.removed')).toBe(false);
    expect(isSuppressibleStreamDelta(null)).toBe(false);
    expect(isSuppressibleStreamDelta(undefined)).toBe(false);
  });
});

describe('window rollover', () => {
  test('resets the counter so a new window starts clean', () => {
    const hot = run(delta(10), T0);
    expect(hot.limited).toBe(true);

    const next = run(delta(5), T0 + WINDOW_MS);
    expect(next.suppressed).toBe(0);
    expect(next.limited).toBe(false);
    expect(next.values).toHaveLength(5);
  });

  test('re-announces in a new window that goes hot again', () => {
    run(delta(10), T0);
    const next = run(delta(10), T0 + WINDOW_MS);

    expect(next.values.filter((v) => v.action === SESSION_EVENT_RATE_LIMITED_ACTION)).toHaveLength(1);
    expect((next.values.at(-1)?.metadata as Record<string, unknown>).consecutive_hot_windows).toBe(2);
  });

  test('a window that stays under the ceiling breaks the hot streak', () => {
    run(delta(10), T0);
    run(delta(1), T0 + WINDOW_MS);
    const third = run(delta(10), T0 + WINDOW_MS * 2);

    expect(third.consecutiveHotWindows).toBe(1);
  });

  test('an idle gap of more than one window breaks the streak', () => {
    run(delta(10), T0);
    const later = run(delta(10), T0 + WINDOW_MS * 3);

    expect(later.consecutiveHotWindows).toBe(1);
  });
});

describe('sustained-hot flagging', () => {
  test('raises the reaper flag only after the configured consecutive windows', () => {
    process.env.KORTIX_AUDIT_SESSION_HOT_WINDOWS = '3';

    const first = run(delta(10), T0);
    expect(first.consecutiveHotWindows).toBe(1);
    expect(first.flagForReaper).toBe(false);

    const second = run(delta(10), T0 + WINDOW_MS);
    expect(second.consecutiveHotWindows).toBe(2);
    expect(second.flagForReaper).toBe(false);

    const third = run(delta(10), T0 + WINDOW_MS * 2);
    expect(third.consecutiveHotWindows).toBe(3);
    expect(third.flagForReaper).toBe(true);
  });

  test('a session that never trips is never flagged', () => {
    process.env.KORTIX_AUDIT_SESSION_HOT_WINDOWS = '1';
    const result = run(delta(2), T0);

    expect(result.flagForReaper).toBe(false);
  });
});

describe('bounded state', () => {
  test('tracked sessions cannot grow without limit', () => {
    process.env.KORTIX_AUDIT_RATE_GUARD_MAX_SESSIONS = '10';

    for (let i = 0; i < 200; i += 1) {
      run(delta(1), T0 + i, `session-${i}`);
    }

    expect(__trackedSessionCountForTest()).toBeLessThanOrEqual(10);
  });
});

describe('configuration', () => {
  test('the shipped default ceiling sits between healthy and runaway traffic', () => {
    delete process.env.KORTIX_AUDIT_SESSION_EVENT_CEILING;
    __resetAuditRateGuardForTest();

    // 257/min was the busiest healthy streaming session measured during the
    // incident; 1725/min was the runaway. The default must clear the first and
    // catch the second.
    const healthy = run(delta(257), T0);
    expect(healthy.suppressed).toBe(0);
    expect(healthy.limited).toBe(false);

    __resetAuditRateGuardForTest();
    const runaway = run(delta(1725), T0);
    expect(runaway.limited).toBe(true);
    expect(runaway.suppressed).toBe(1725 - 900);
  });

  test('an invalid env override falls back to the safe default', () => {
    process.env.KORTIX_AUDIT_SESSION_EVENT_CEILING = 'not-a-number';
    __resetAuditRateGuardForTest();

    const result = run(delta(257), T0);
    expect(result.limited).toBe(false);
  });
});
