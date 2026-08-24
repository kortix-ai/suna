import { describe, expect, test } from 'bun:test';
import {
  connectionIsFaulted,
  projectSessionConnection,
  type SessionConnectionInputs,
} from './connection';

const base: SessionConnectionInputs = { sandbox: null, runtimeReady: false };

describe('projectSessionConnection', () => {
  // The reported failure: a reload of a session whose sandbox is UP and
  // mid-turn announced "Waking this session up…" for seconds. The frontend had
  // asked nobody yet and turned that silence into a claim.
  test('a cold load knows NOTHING and says so', () => {
    expect(projectSessionConnection(base)).toBe('unknown');
  });

  test('a running sandbox that has not answered yet is CONNECTING, never waking', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'running' })).toBe('connecting');
  });

  test('only the control plane saying the box is down earns the word "waking"', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'stopped' })).toBe('waking');
    expect(projectSessionConnection({ ...base, sandbox: 'provisioning' })).toBe('waking');
    expect(projectSessionConnection({ ...base, sandbox: 'archived' })).toBe('waking');
  });

  test('a health pass is live', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'stopped', runtimeReady: true })).toBe(
      'live',
    );
  });

  // Content is the runtime itself, not a report about it: it outranks a probe
  // that has given up on a different path, and a row that is out of date.
  test('content arriving is live, over any probe and any row', () => {
    expect(
      projectSessionConnection({
        ...base,
        sandbox: 'stopped',
        unreachable: true,
        stalled: true,
        activityFresh: true,
      }),
    ).toBe('live');
  });

  test('a probe that gave up, or a boot that stalled, is unreachable', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'running', unreachable: true })).toBe(
      'unreachable',
    );
    expect(projectSessionConnection({ ...base, sandbox: 'running', stalled: true })).toBe(
      'unreachable',
    );
  });

  test('pre-boot lifecycle states are waking', () => {
    for (const sandbox of ['queued', 'branching'] as const) {
      expect(projectSessionConnection({ ...base, sandbox })).toBe('waking');
    }
  });

  test('a completed session has nothing to wake and nothing to announce', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'completed' })).toBe('unknown');
  });

  test('a failed sandbox is a fault, not a wait', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'failed' })).toBe('unreachable');
  });

  /**
   * `project_sessions.status` is read on a 30s freshness tier, so it CAN be up
   * to half a minute behind the box. Both directions of that lag are covered by
   * ordering alone — which is the reason the probe outranks the row.
   */
  test('a stale `stopped` row never contradicts a live runtime', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'stopped', runtimeReady: true })).toBe(
      'live',
    );
    expect(projectSessionConnection({ ...base, sandbox: 'stopped', activityFresh: true })).toBe(
      'live',
    );
  });

  test('a stale `running` row never hides a dead runtime', () => {
    expect(projectSessionConnection({ ...base, sandbox: 'running', unreachable: true })).toBe(
      'unreachable',
    );
  });
});

describe('connectionIsFaulted', () => {
  test('only unreachable is a fault — a wait is not', () => {
    expect(connectionIsFaulted('unreachable')).toBe(true);
    for (const state of ['unknown', 'connecting', 'waking', 'live'] as const) {
      expect(connectionIsFaulted(state)).toBe(false);
    }
  });
});
