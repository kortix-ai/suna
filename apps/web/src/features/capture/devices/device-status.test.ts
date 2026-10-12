import { describe, expect, test } from 'bun:test';
import type { CaptureDevice } from '@kortix/sdk';

import { deviceStatus } from './device-status';

const device = (status: Record<string, unknown> | null, state = 'recording') =>
  ({ live: { state, status, reported_at: '2026-10-12T10:00:00.000Z' } }) as unknown as CaptureDevice;

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
});
