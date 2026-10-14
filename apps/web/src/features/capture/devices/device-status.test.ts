import { describe, expect, test } from 'bun:test';
import type { CaptureDevice } from '@kortix/sdk';

import { deviceStatus } from './device-status';

const device = (status: Record<string, unknown> | null, state = 'recording', health?: Record<string, unknown>) =>
  ({
    live: { state, status, reported_at: '2026-10-12T10:00:00.000Z' },
    app_version: '0.1.0',
    health: { state: 'healthy', idle: false, reasons: [], since: null, latest_version: null, ...health },
  }) as unknown as CaptureDevice;

describe('deviceStatus', () => {
  test('reads the frame interval and resolution the device reports', () => {
    const view = deviceStatus(device({ actionsRecording: true, capture: { intervalMs: 1000, maxHeight: 2160 } }));
    expect(view.frames).toEqual({ intervalMs: 1000, maxHeight: 2160 });
    expect(view.layers).toEqual(['screen', 'actions']);
  });

  test('a device that does not report them yet shows none', () => {
    expect(deviceStatus(device({})).frames).toBeNull();
    expect(deviceStatus(device({ capture: { intervalMs: 'x' } })).frames).toBeNull();
    expect(deviceStatus(device(null, 'offline')).frames).toBeNull();
  });

  test('a recorder that reports recording but is stalled shows as not recording, in red, with its last frame', () => {
    const view = deviceStatus(device({ lastFrameMs: 1234 }, 'recording', { state: 'not_recording', reasons: ['stalled'] }));
    expect(view).toMatchObject({ key: 'notRecording', tone: 'red', health: [{ code: 'stalled', timeMs: 1234 }] });
  });

  test('attention is orange; a recording computer behind on version says which versions', () => {
    const view = deviceStatus(device({}, 'recording', { state: 'attention', reasons: ['behind_version'], latest_version: '0.2.0' }));
    expect(view).toMatchObject({ key: 'recording', tone: 'orange', health: [{ code: 'behind_version', version: '0.2.0', current: '0.1.0' }] });
  });

  test('a silent computer that was idle reads as asleep, not offline-broken', () => {
    const view = deviceStatus(device({}, 'offline', { idle: true }));
    expect(view).toMatchObject({ key: 'offline', tone: 'none' });
    expect(view.health[0]?.code).toBe('asleep');
  });

  test('a backlog names how many items wait', () => {
    const view = deviceStatus(device({ sync: { pending: 40 } }, 'recording', { state: 'attention', reasons: ['backlog'] }));
    expect(view.health).toEqual([{ code: 'backlog', count: 40 }]);
  });
});
