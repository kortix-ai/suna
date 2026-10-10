import { describe, expect, test } from 'bun:test';
import {
  appColor,
  dayWindow,
  durationParts,
  hourTicks,
  indexAtOrBefore,
  localDayOf,
  trackSpan,
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

  test('the track spans the recorded hours, padded to whole hours; an empty day shows 08:00 to 18:00', () => {
    const { from } = dayWindow('2026-10-03');
    const base = Date.parse(from);
    const span = trackSpan('2026-10-03', base + 9.2 * 3_600_000, base + 14.5 * 3_600_000);
    expect(new Date(span.start).getHours()).toBe(9);
    expect(new Date(span.end).getHours()).toBe(15);
    expect(hourTicks(span.start, span.end).length).toBe(7);
    const empty = trackSpan('2026-10-03', null, null);
    expect(new Date(empty.start).getHours()).toBe(8);
    expect(new Date(empty.end).getHours()).toBe(18);
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

  test('an app keeps one chart token; no app is muted', () => {
    expect(appColor('Mail')).toBe(appColor('Mail'));
    expect(appColor('Mail')).toMatch(/^var\(--chart-[1-5]\)$/);
    expect(appColor(null)).toBe('var(--muted-foreground)');
  });
});

describe('device status', () => {
  const device = (state: string, status: Record<string, unknown> | null) =>
    ({
      device_id: 'd1',
      user_id: 'u1',
      name: 'Laptop',
      os: 'macos',
      os_version: '15',
      arch: 'arm64',
      app_version: '0.3.0',
      live: { state, status, reported_at: '2026-10-03T10:00:00.000Z' },
      policy_override: null,
      last_credentials_at: null,
      revoked_at: null,
      created_at: '2026-10-01T10:00:00.000Z',
    }) as const;

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
