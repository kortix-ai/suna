/**
 * A device row's live status, from `live.state` and the device's last
 * `status.json` (the Kortix Capture format, schema 2). Status hues follow the
 * brand status table: green records, orange needs a person (a missing
 * permission, a pause), no hue is idle (offline, not recording, unknown).
 */
import type { CaptureDevice, CaptureHealthReason, CaptureLayer } from '@kortix/sdk';

export type DeviceTone = 'green' | 'orange' | 'red' | 'none';
export type DeviceStatusKey =
  | 'recording'
  | 'paused'
  | 'locked'
  | 'excluded'
  | 'permission'
  | 'notRecording'
  | 'offline'
  | 'unknown';

/** status.json `reason`s that stop recording without anyone pausing it (the engine's words). */
const LOCKED = new Set(['locked']);
const EXCLUDED = new Set(['excluded_app', 'excluded_domain', 'private_browsing', 'unknown_bundle']);
export type DeviceLayer = CaptureLayer;

export interface DeviceStatusView {
  key: DeviceStatusKey;
  tone: DeviceTone;
  /** Missing OS permissions, as the device names them (`screen_recording`, …). */
  missingPermissions: string[];
  pausedUntilMs: number | null;
  /** The last status report (ms), for "last seen". */
  reportedAtMs: number | null;
  layers: DeviceLayer[];
  /** Items waiting to upload; 0 = up to date; null = unknown. */
  pending: number | null;
  syncFailed: boolean;
  lastFrameMs: number | null;
  /** The screen frame interval and resolution in force on the device; null before it reports them. */
  frames: { intervalMs: number; maxHeight: number } | null;
  /** Why the fleet health rules flag this computer, most urgent first, in plain-word keys. */
  health: HealthLine[];
}

/** One plain-word line under the status: a `capture.devices.health.<code>` key and its values. */
export interface HealthLine {
  code: CaptureHealthReason | 'asleep';
  /** Epoch ms for `{time}` (last seen / last frame), items waiting for `{count}`, versions. */
  timeMs?: number;
  count?: number;
  version?: string;
  current?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function deviceStatus(device: CaptureDevice): DeviceStatusView {
  const status = record(device.live.status);
  const sync = record(status.sync);
  const audio = record(status.audio);
  const capture = record(status.capture);
  const intervalMs = num(capture.intervalMs);
  const maxHeight = num(capture.maxHeight);
  const state = device.live.state;
  const reason = typeof status.reason === 'string' ? status.reason : '';
  const stopped = state === 'paused' || state === 'not_recording';
  const key: DeviceStatusKey =
    state === 'recording'
      ? 'recording'
      : stopped && LOCKED.has(reason)
        ? 'locked'
        : stopped && EXCLUDED.has(reason)
          ? 'excluded'
          : state === 'paused'
            ? 'paused'
            : state === 'permission_missing'
              ? 'permission'
              : state === 'not_recording'
                ? 'notRecording'
                : state === 'offline'
                  ? 'offline'
                  : 'unknown';
  const health = device.health;
  // The health rules win over the raw state: a recorder that reports "recording" but wrote no frame is not recording.
  const shown: DeviceStatusKey = health?.state === 'not_recording' && key === 'recording' ? 'notRecording' : key;
  const lastFrameMs = num(status.lastFrameMs);
  const reportedAtMs = device.live.reported_at ? Date.parse(device.live.reported_at) : null;
  const lines: HealthLine[] = (health?.reasons ?? []).map((code) => {
    if (code === 'offline') return { code, timeMs: reportedAtMs ?? undefined };
    if (code === 'stalled' || code === 'error') return { code, timeMs: lastFrameMs ?? undefined };
    if (code === 'backlog') return { code, count: num(sync.pending) ?? undefined };
    if (code === 'behind_version') return { code, version: health.latest_version ?? undefined, current: device.app_version ?? undefined };
    return { code };
  });
  if (health?.idle && key === 'offline') lines.push({ code: 'asleep', timeMs: reportedAtMs ?? undefined });
  const layers: DeviceLayer[] = ['screen'];
  if (status.actionsRecording === true) layers.push('actions');
  if (audio.enabled === true) layers.push('audio');
  return {
    key: shown,
    tone:
      health?.state === 'not_recording'
        ? 'red'
        : health?.state === 'attention'
          ? 'orange'
          : key === 'recording'
            ? 'green'
            : key === 'paused' || key === 'permission'
              ? 'orange'
              : 'none',
    missingPermissions: Array.isArray(status.missingPermissions)
      ? status.missingPermissions.filter((p): p is string => typeof p === 'string')
      : [],
    pausedUntilMs: num(status.pausedUntilMs),
    reportedAtMs: device.live.reported_at ? Date.parse(device.live.reported_at) : null,
    layers,
    pending: num(sync.pending),
    syncFailed: typeof sync.errorClass === 'string' && sync.errorClass.length > 0,
    lastFrameMs: num(status.lastFrameMs),
    frames: intervalMs && maxHeight ? { intervalMs, maxHeight } : null,
    health: lines,
  };
}
