import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '../rest/projects-client/sessions';
import {
  SESSION_LIST_STATUS,
  SESSION_NOTICE,
  SESSION_STARTING_STUCK_MS,
  isLegacyMigratedSession,
  sessionConnectionLabel,
  sessionListStatus,
  sessionStartingStuck,
  turnRetryLabel,
} from './status-vocabulary';

/**
 * Web and mobile each derived and worded session states themselves: a
 * finished session read "Done" in the web sidebar, "Completed" on the web
 * Sessions page and "Stopped" on mobile; the machine behind a session was a
 * "sandbox", a "runtime", a "workspace" or a "computer" depending on the
 * screen. These tests pin the one vocabulary both hosts now read.
 */

const session = (status: string, metadata: Record<string, unknown> = {}) =>
  ({ session_id: 's1', status, metadata }) as unknown as ProjectSession;

describe('a session in a list', () => {
  test.each([
    ['queued', 'starting'],
    ['branching', 'starting'],
    ['provisioning', 'starting'],
    ['running', 'running'],
    ['completed', 'done'],
    ['stopped', 'stopped'],
    ['failed', 'failed'],
  ])('%s reads as %s', (status, expected) => {
    expect(sessionListStatus(session(status))).toBe(expected as never);
  });

  test('a pending review outranks every lifecycle state', () => {
    expect(sessionListStatus(session('completed'), 2)).toBe('needs-you');
    expect(sessionListStatus(session('running'), 1)).toBe('needs-you');
  });

  test('a migrated session that has not run reads as legacy', () => {
    const migrated = session('stopped', { legacy_migration: { at: '2026-01-01' } });
    expect(isLegacyMigratedSession(migrated)).toBe(true);
    expect(sessionListStatus(migrated)).toBe('legacy');
    expect(sessionListStatus(session('running', { legacy_migration: true }))).toBe('running');
  });

  test('a status this build has never seen is stopped, never failed', () => {
    expect(sessionListStatus(session('hibernating'))).toBe('stopped');
  });

  test('a session in the starting family past the stuck threshold reads stuck', () => {
    const START = Date.parse('2026-10-06T10:00:00Z');
    const row = (status: string, updatedAt: string, metadata: Record<string, unknown> = {}) =>
      ({ session_id: 's1', status, metadata, updated_at: updatedAt }) as unknown as ProjectSession;
    const at = (ms: number) => new Date(START + ms).toISOString();
    // A boot younger than the threshold is starting, not stuck.
    expect(
      sessionStartingStuck(row('provisioning', at(0)), START + SESSION_STARTING_STUCK_MS - 1),
    ).toBe(false);
    // At the threshold it flips. Five minutes is the chosen UX threshold for
    // the whole starting family — the server's stale-provisioning reconcile
    // is 5 min for a started provision, 10 min for a provider-queued box —
    // so minutes 5–10 can name a boot the server still calls young. That is
    // the point of a customer-facing threshold.
    expect(sessionStartingStuck(row('provisioning', at(0)), START + SESSION_STARTING_STUCK_MS)).toBe(
      true,
    );
    // The other starting-family members carry the same clock.
    expect(sessionStartingStuck(row('queued', at(0)), START + SESSION_STARTING_STUCK_MS)).toBe(true);
    expect(sessionStartingStuck(row('branching', at(0)), START + SESSION_STARTING_STUCK_MS)).toBe(
      true,
    );
  });

  test('stuck reads false for everything that is not a wedged boot', () => {
    const START = Date.parse('2026-10-06T10:00:00Z');
    const stale = new Date(START).toISOString();
    const row = (status: string, metadata: Record<string, unknown> = {}) =>
      ({ session_id: 's1', status, metadata, updated_at: stale }) as unknown as ProjectSession;
    // Running, done, stopped, failed: the clock does not apply.
    expect(sessionStartingStuck(row('running'), START + SESSION_STARTING_STUCK_MS)).toBe(false);
    expect(sessionStartingStuck(row('completed'), START + SESSION_STARTING_STUCK_MS)).toBe(false);
    expect(sessionStartingStuck(row('failed'), START + SESSION_STARTING_STUCK_MS)).toBe(false);
    // A warm row (pre-created, never prompted) reports `provisioning` on
    // purpose (KRTX-1466) and sits there until its first send. It is ready,
    // not wedged.
    expect(
      sessionStartingStuck(row('provisioning', { warm: true }), START + SESSION_STARTING_STUCK_MS),
    ).toBe(false);
    // A missing or malformed clock never invents a stuck state.
    expect(
      sessionStartingStuck(
        { session_id: 's1', status: 'provisioning', metadata: {} } as unknown as ProjectSession,
        START + SESSION_STARTING_STUCK_MS,
      ),
    ).toBe(false);
  });

  test('a restart resets the stuck clock, because the transition rewrites updated_at', () => {
    const START = Date.parse('2026-10-06T10:00:00Z');
    // An old session restarted now re-enters `provisioning` with a fresh
    // `updatedAt` (status-transitions.ts writes `updatedAt: new Date()`), so
    // the row must read young again, not stuck on its birth date.
    const restarted = {
      session_id: 's1',
      status: 'provisioning',
      metadata: {},
      updated_at: new Date(START).toISOString(),
    } as unknown as ProjectSession;
    expect(sessionStartingStuck(restarted, START)).toBe(false);
  });

  test('every status has a label and a tone; green means live or actionable only', () => {
    for (const [status, wording] of Object.entries(SESSION_LIST_STATUS)) {
      expect(wording.label.length).toBeGreaterThan(0);
      if (wording.tone === 'live' || wording.tone === 'actionable') {
        expect(['running', 'needs-you']).toContain(status);
      }
    }
    expect(SESSION_LIST_STATUS.done.label).toBe('Done');
    expect(SESSION_LIST_STATUS.done.tone).toBe('muted');
  });
});

describe("the session's computer", () => {
  test('a short label for each connection state, and nothing while it is unknown or live', () => {
    expect(sessionConnectionLabel('unknown')).toBeNull();
    expect(sessionConnectionLabel('live')).toBeNull();
    expect(sessionConnectionLabel('waking')?.label).toBe('Waking computer');
    expect(sessionConnectionLabel('connecting')?.label).toBe('Connecting');
    expect(sessionConnectionLabel('unreachable')).toEqual({ label: "Can't reach computer", tone: 'danger' });
  });

  test('notices name the machine one way: "computer"', () => {
    for (const notice of Object.values(SESSION_NOTICE)) {
      expect(notice).not.toMatch(/\b(sandbox|runtime|workspace|box)\b/i);
    }
  });

  test('a parked computer, not the conversation, sleeps until the next message', () => {
    expect(SESSION_NOTICE.idle).toMatch(/computer is asleep/i);
    expect(SESSION_NOTICE.idle).toMatch(/next message wakes.*delivered/i);
    expect(SESSION_NOTICE.idle).not.toMatch(/session is idle/i);
  });
});

describe('a turn waiting to retry', () => {
  test('counts down, then says it is retrying now', () => {
    expect(turnRetryLabel(5)).toBe('Retrying in 5s');
    expect(turnRetryLabel(0)).toBe('Retrying now');
    expect(turnRetryLabel(null)).toBe('Waiting to retry');
  });
});
