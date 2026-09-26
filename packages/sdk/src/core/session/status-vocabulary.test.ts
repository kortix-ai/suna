import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '../rest/projects-client/sessions';
import {
  SESSION_LIST_STATUS,
  SESSION_NOTICE,
  isLegacyMigratedSession,
  sessionConnectionLabel,
  sessionListStatus,
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
});

describe('a turn waiting to retry', () => {
  test('counts down, then says it is retrying now', () => {
    expect(turnRetryLabel(5)).toBe('Retrying in 5s');
    expect(turnRetryLabel(0)).toBe('Retrying now');
    expect(turnRetryLabel(null)).toBe('Waiting to retry');
  });
});
