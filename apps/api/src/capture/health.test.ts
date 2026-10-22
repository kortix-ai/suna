import { describe, expect, test } from 'bun:test';
import { classifyDevice, isOlderVersion, summarizeHealth, type HealthInput } from './health';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function device(status: Record<string, unknown>, ageMs = 10_000): HealthInput {
  return { status: { reportedAtMs: NOW - ageMs, recording: 'recording', reason: null, ...status }, reportedAt: null, appVersion: null };
}
const at = (minutesAgo: number) => NOW - minutesAgo * MIN;
const classify = (input: HealthInput, extra: { latestVersion?: string | null; notRecordingAfterMs?: number } = {}) =>
  classifyDevice(input, { now: NOW, ...extra });

describe('classifyDevice: reporting devices', () => {
  test('recording with a fresh frame is healthy and not idle', () => {
    const h = classify(device({ lastFrameMs: NOW - 5_000, host: { awakeSinceMs: at(600) } }));
    expect(h).toMatchObject({ state: 'healthy', idle: false, reasons: [], since: null });
  });

  test('recording with no frame for 5+ awake minutes is not recording (stalled)', () => {
    const h = classify(device({ lastFrameMs: at(12), host: { awakeSinceMs: at(600) } }));
    expect(h.state).toBe('not_recording');
    expect(h.reasons).toEqual(['stalled']);
    expect(h.since).toBe(new Date(at(12)).toISOString());
  });

  test('a wake from sleep restarts the clock: old frame, fresh wake is healthy', () => {
    const h = classify(device({ lastFrameMs: at(600), host: { awakeSinceMs: at(1) } }));
    expect(h.state).toBe('healthy');
  });

  test('locked and inactive are idle, not broken', () => {
    for (const reason of ['locked', 'inactive']) {
      const h = classify(device({ recording: 'paused', reason, lastFrameMs: at(300), host: { awakeSinceMs: at(600) } }));
      expect(h).toMatchObject({ state: 'healthy', idle: true });
    }
  });

  test('an excluded app pauses recording by design and stays healthy', () => {
    const h = classify(device({ recording: 'paused', reason: 'excluded_app', lastFrameMs: at(20) }));
    expect(h).toMatchObject({ state: 'healthy', idle: false });
  });

  test('a person pause needs attention', () => {
    const h = classify(device({ recording: 'paused', reason: 'paused', lastFrameMs: at(20) }));
    expect(h).toMatchObject({ state: 'attention', reasons: ['paused'] });
  });

  test('a missing permission needs attention', () => {
    const h = classify(device({ recording: 'permission_missing', reason: 'permission_missing', missingPermissions: ['screen_recording'] }));
    expect(h).toMatchObject({ state: 'attention', reasons: ['permission_missing'] });
  });

  test('not_recording with an error is tolerated for 5 minutes, then is not recording', () => {
    const base = { recording: 'not_recording', reason: 'error', host: { awakeSinceMs: at(600) } };
    expect(classify(device({ ...base, lastFrameMs: at(2) })).state).toBe('healthy');
    const h = classify(device({ ...base, lastFrameMs: at(40) }));
    expect(h).toMatchObject({ state: 'not_recording', reasons: ['error'] });
  });

  test('a sync error and a backlog need attention; a fresh upload does not', () => {
    const awake = { host: { awakeSinceMs: at(600) }, lastFrameMs: NOW - 1000 };
    const stale = classify(device({ ...awake, sync: { state: 'queued', pending: 40, lastUploadMs: at(45) } }));
    expect(stale).toMatchObject({ state: 'attention', reasons: ['backlog'] });
    const fresh = classify(device({ ...awake, sync: { state: 'queued', pending: 40, lastUploadMs: at(2) } }));
    expect(fresh.state).toBe('healthy');
    const err = classify(device({ ...awake, sync: { state: 'error', pending: 3, errorClass: 'auth', lastUploadMs: at(2) } }));
    expect(err.reasons).toEqual(['sync_error']);
  });

  test('a backlog does not count time the computer slept', () => {
    const h = classify(device({ lastFrameMs: NOW - 1000, host: { awakeSinceMs: at(3) }, sync: { state: 'queued', pending: 40, lastUploadMs: at(300) } }));
    expect(h.state).toBe('healthy');
  });

  test('sync off never reports a backlog', () => {
    const h = classify(device({ lastFrameMs: NOW - 1000, host: { awakeSinceMs: at(600) }, sync: { state: 'off', pending: 9 } }));
    expect(h.state).toBe('healthy');
  });

  test('an old app version needs attention only when the newest is known', () => {
    const input = { ...device({ lastFrameMs: NOW - 1000, appVersion: '0.1.0' }), appVersion: '0.1.0' };
    expect(classify(input, { latestVersion: '0.2.0' })).toMatchObject({ state: 'attention', reasons: ['behind_version'], latest_version: '0.2.0' });
    expect(classify(input, { latestVersion: null }).state).toBe('healthy');
    expect(classify(input, { latestVersion: '0.1.0' }).state).toBe('healthy');
  });

  test('not recording outranks attention in the reasons and the state', () => {
    const h = classify(device({ lastFrameMs: at(30), appVersion: '0.1.0', sync: { state: 'error' } }), { latestVersion: '0.2.0' });
    expect(h.state).toBe('not_recording');
    expect(h.reasons).toEqual(['stalled', 'sync_error', 'behind_version']);
  });
});

describe('classifyDevice: silent devices', () => {
  test('silent while it was recording: healthy and idle before the limit, not recording after', () => {
    expect(classify(device({ lastFrameMs: at(20) }, 20 * MIN))).toMatchObject({ state: 'healthy', idle: true });
    const h = classify(device({ lastFrameMs: at(40) }, 40 * MIN));
    expect(h).toMatchObject({ state: 'not_recording', reasons: ['offline'] });
    expect(h.since).toBe(new Date(at(40)).toISOString());
  });

  test('silent after a locked or paused report is asleep, not broken, for days', () => {
    const locked = device({ recording: 'paused', reason: 'locked' }, 10 * 3_600_000);
    expect(classify(locked)).toMatchObject({ state: 'healthy', idle: true });
    const paused = device({ recording: 'paused', reason: 'paused' }, 3 * 86_400_000);
    expect(classify(paused)).toMatchObject({ state: 'healthy', idle: true });
  });

  test('the limit is configurable', () => {
    expect(classify(device({}, 10 * MIN), { notRecordingAfterMs: 5 * MIN }).state).toBe('not_recording');
  });

  test('silent for 7 days needs attention', () => {
    expect(classify(device({ recording: 'paused', reason: 'locked' }, 8 * 86_400_000))).toMatchObject({ state: 'attention', reasons: ['unseen'] });
  });

  test('never reported needs attention', () => {
    expect(classify({ status: null, reportedAt: null, appVersion: null })).toMatchObject({ state: 'attention', reasons: ['never_reported'] });
  });
});

describe('versions and summary', () => {
  test('isOlderVersion compares numbers, not strings', () => {
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true);
    expect(isOlderVersion('1.0.0', '0.10.0')).toBe(false);
    expect(isOlderVersion('v0.1.0-dev.12', '0.1.0')).toBe(false);
    expect(isOlderVersion(null, '0.1.0')).toBe(false);
    expect(isOlderVersion('garbage', '0.1.0')).toBe(false);
  });

  test('summarizeHealth counts each device once', () => {
    const ok = classify(device({ lastFrameMs: NOW - 1000 }));
    const idle = classify(device({ recording: 'paused', reason: 'locked' }));
    const attention = classify(device({ recording: 'paused', reason: 'paused' }));
    const down = classify(device({ lastFrameMs: at(30) }));
    expect(summarizeHealth([ok, ok, idle, attention, down], '0.2.0')).toEqual({ recording: 2, idle: 1, attention: 1, not_recording: 1, latest_version: '0.2.0' });
  });
});
