import { describe, expect, test } from 'bun:test';
import type { CaptureDevice } from '@kortix/sdk';
import {
  dayWindow,
  durationParts,
  indexAtOrBefore,
  localDayOf,
} from './capture-time';
import { deviceStatus } from './devices/device-status';

describe('capture time', () => {
  test('a local day window runs from local midnight to the next local midnight', () => {
    const { from, to } = dayWindow('2026-10-03');
    expect(localDayOf(from)).toBe('2026-10-03');
    expect(new Date(from).getHours()).toBe(0);
    expect(localDayOf(to)).toBe('2026-10-04');
    expect(new Date(to).getHours()).toBe(0);
  });

  test('durations round to the minute; the moment lookup finds the last item at or before a time', () => {
    expect(durationParts(3_725)).toEqual({ hours: 1, minutes: 2 });
    expect(durationParts(-5)).toEqual({ hours: 0, minutes: 0 });
    const items = [
      { ts: '2026-10-03T09:00:00.000Z' },
      { ts: '2026-10-03T09:00:20.000Z' },
      { ts: '2026-10-03T09:00:40.000Z' },
    ];
    expect(indexAtOrBefore(items, Date.parse('2026-10-03T09:00:30.000Z'))).toBe(1);
    expect(indexAtOrBefore(items, Date.parse('2026-10-03T08:59:59.000Z'))).toBe(-1);
    expect(indexAtOrBefore(items, Date.parse('2026-10-03T10:00:00.000Z'))).toBe(2);
  });
});

describe('device status', () => {
  const device = (state: string, status: Record<string, unknown> | null): CaptureDevice =>
    ({
      device_id: 'd1',
      user_id: 'u1',
      name: 'Laptop',
      os: 'macos',
      os_version: '15',
      arch: 'arm64',
      app_version: '0.3.0',
      displays: [],
      live: { state, status, reported_at: '2026-10-03T10:00:00.000Z' },
      last_credentials_at: null,
      revoked_at: null,
      created_at: '2026-10-01T10:00:00.000Z',
    }) as unknown as CaptureDevice;

  test('recording is green with its layers, queue and last frame', () => {
    const view = deviceStatus(
      device('recording', {
        actionsRecording: true,
        audio: { enabled: true },
        sync: { state: 'ok', pending: 3 },
        lastFrameMs: 1_000,
      }),
    );
    expect(view).toMatchObject({
      key: 'recording',
      tone: 'green',
      layers: ['screen', 'actions', 'audio'],
      pending: 3,
      syncFailed: false,
      lastFrameMs: 1_000,
    });
  });

  test('a locked screen or an excluded app in front is not a pause: own words, no hue', () => {
    expect(deviceStatus(device('paused', { reason: 'locked' }))).toMatchObject({ key: 'locked', tone: 'none' });
    expect(deviceStatus(device('not_recording', { reason: 'locked' }))).toMatchObject({ key: 'locked', tone: 'none' });
    for (const reason of ['excluded_app', 'excluded_domain', 'not_included', 'private_browsing']) {
      expect(deviceStatus(device('paused', { reason }))).toMatchObject({ key: 'excluded', tone: 'none' });
    }
    expect(deviceStatus(device('paused', { reason: 'paused' }))).toMatchObject({ key: 'paused', tone: 'orange' });
  });

  test('a missing permission and a pause are orange; offline and unknown carry no hue', () => {
    expect(
      deviceStatus(device('permission_missing', { missingPermissions: ['screen_recording', 7] })),
    ).toMatchObject({
      key: 'permission',
      tone: 'orange',
      missingPermissions: ['screen_recording'],
    });
    expect(deviceStatus(device('paused', { pausedUntilMs: 5 }))).toMatchObject({
      key: 'paused',
      tone: 'orange',
      pausedUntilMs: 5,
    });
    expect(deviceStatus(device('offline', null))).toMatchObject({
      key: 'offline',
      tone: 'none',
      layers: ['screen'],
      pending: null,
    });
    expect(deviceStatus(device('something_new', null)).key).toBe('unknown');
    expect(deviceStatus(device('recording', { sync: { errorClass: 'network' } })).syncFailed).toBe(
      true,
    );
  });
});
