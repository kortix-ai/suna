/**
 * Fleet health of Kortix Capture devices: one pure classifier over a device's
 * last `status.json`. The devices endpoint (reads.ts) and the alert worker
 * (health-alerts.ts) call it, so the page and the alert never disagree.
 *
 * A device is `healthy`, `attention` (it records, or will record again on its
 * own, but a person should look) or `not_recording`. The rules, in order:
 *
 *  A silent device (no report for 120 s) may be asleep: the app cannot report
 *  while the computer sleeps. It is healthy and `idle` when its last report said
 *  locked, inactive or paused. Otherwise it is `not_recording` (reason
 *  `offline`) once it has been silent for `notRecordingAfterMs` (default 30 min).
 *  Silent for 7 days: `attention` (`unseen`). Never reported: `attention`.
 *
 *  A reporting device is judged on what it reports:
 *   - `recording` but no frame for 5 min of awake time: `not_recording` (`stalled`).
 *     Awake time starts at `host.awakeSinceMs`, so a wake from sleep never counts.
 *   - `not_recording` for any reason except locked or inactive, and no frame for
 *     5 min of awake time: `not_recording` (`error`).
 *   - `permission_missing`: `attention`. `paused` by the person: `attention`.
 *   - locked or inactive: healthy, `idle`. Excluded app or site: healthy.
 *  Then, on any reporting device, `attention` is added for a sync error, an
 *  upload backlog (items pending, nothing uploaded for 30 min of awake time) and
 *  an app older than the newest published version.
 */
import { OFFLINE_AFTER_MS, statusReportedAt } from './format';

export type HealthState = 'healthy' | 'attention' | 'not_recording';
export type HealthReason =
  | 'offline'
  | 'stalled'
  | 'error'
  | 'never_reported'
  | 'unseen'
  | 'permission_missing'
  | 'paused'
  | 'sync_error'
  | 'backlog'
  | 'behind_version';

export interface DeviceHealth {
  state: HealthState;
  /** Healthy but not recording on purpose: locked, inactive, or silent while it was idle. */
  idle: boolean;
  /** Most urgent first. Empty when healthy. */
  reasons: HealthReason[];
  /** When the not-recording spell began (ISO), for `offline`, `stalled` and `error`. */
  since: string | null;
  /** The newest published version, only when this device is behind it. */
  latest_version: string | null;
}

export interface HealthSummary {
  recording: number;
  idle: number;
  attention: number;
  not_recording: number;
  /** The newest published Capture version, or null when unknown. */
  latest_version: string | null;
}

export const STALL_AFTER_MS = 5 * 60_000;
export const BACKLOG_AFTER_MS = 30 * 60_000;
export const UNSEEN_AFTER_MS = 7 * 86_400_000;
export const NOT_RECORDING_AFTER_MS = 30 * 60_000;

export interface HealthInput {
  status: Record<string, unknown> | null | undefined;
  reportedAt: Date | null;
  appVersion: string | null;
}

export interface HealthOptions {
  now: number;
  latestVersion?: string | null;
  notRecordingAfterMs?: number;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** status.json `reason`s that mean the computer is in use by nobody. */
const RESTING = new Set(['locked', 'inactive']);

/** `1.2.3` older than `1.2.4`; a prerelease or build suffix is ignored. Unparsable: not older. */
export function isOlderVersion(version: string | null | undefined, latest: string | null | undefined): boolean {
  const parts = (v: string | null | undefined) => /^v?(\d+)\.(\d+)\.(\d+)/.exec((v ?? '').trim())?.slice(1).map(Number);
  const a = parts(version);
  const b = parts(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

const ORDER: HealthReason[] = ['offline', 'stalled', 'error', 'never_reported', 'unseen', 'permission_missing', 'paused', 'sync_error', 'backlog', 'behind_version'];
const NOT_RECORDING = new Set<HealthReason>(['offline', 'stalled', 'error']);

function result(reasons: HealthReason[], idle: boolean, since: number | null, latest: string | null): DeviceHealth {
  const sorted = ORDER.filter((reason) => reasons.includes(reason));
  const state: HealthState = sorted.some((r) => NOT_RECORDING.has(r)) ? 'not_recording' : sorted.length ? 'attention' : 'healthy';
  return {
    state,
    idle: state === 'healthy' && idle,
    reasons: sorted,
    since: state === 'not_recording' && since !== null ? new Date(since).toISOString() : null,
    latest_version: sorted.includes('behind_version') ? latest : null,
  };
}

export function classifyDevice(input: HealthInput, options: HealthOptions): DeviceHealth {
  const { now } = options;
  const limit = options.notRecordingAfterMs ?? NOT_RECORDING_AFTER_MS;
  const latest = options.latestVersion ?? null;
  const status = input.status ?? null;
  const reported = statusReportedAt(status) ?? input.reportedAt?.getTime() ?? null;
  if (!status || reported === null) return result(['never_reported'], false, null, latest);

  const state = text(status.recording);
  const reason = text(status.reason);
  const resting = RESTING.has(reason);

  if (now - reported > OFFLINE_AFTER_MS) {
    const silentMs = now - reported;
    if (silentMs > UNSEEN_AFTER_MS) return result(['unseen'], false, null, latest);
    // Asleep or off while the person was away, paused, or in a resting state: not a fault.
    if (resting || state === 'paused') return result([], true, null, latest);
    if (silentMs >= limit) return result(['offline'], false, reported, latest);
    return result([], true, null, latest);
  }

  const reasons: HealthReason[] = [];
  const awakeSince = num(record(status.host).awakeSinceMs);
  const lastFrame = num(status.lastFrameMs);
  const lastProgress = Math.max(lastFrame ?? 0, awakeSince ?? 0);
  const stalledSince = lastProgress > 0 && now - lastProgress > STALL_AFTER_MS ? lastProgress : null;
  let since: number | null = null;

  if (state === 'recording') {
    if (stalledSince !== null) {
      reasons.push('stalled');
      since = stalledSince;
    }
  } else if (state === 'permission_missing') {
    reasons.push('permission_missing');
  } else if (state === 'paused') {
    if (reason === 'paused') reasons.push('paused');
  } else if (state === 'not_recording' && !resting) {
    if (stalledSince !== null) {
      reasons.push('error');
      since = stalledSince;
    }
  }

  const sync = record(status.sync);
  if (sync.state === 'error') reasons.push('sync_error');
  const pending = num(sync.pending);
  const uploadRef = num(sync.lastUploadMs) ?? awakeSince;
  if (pending !== null && sync.state !== 'off' && uploadRef !== null && now - Math.max(uploadRef, awakeSince ?? 0) > BACKLOG_AFTER_MS) {
    reasons.push('backlog');
  }
  if (isOlderVersion(text(status.appVersion) || input.appVersion, latest)) reasons.push('behind_version');

  return result(reasons, resting, since, latest);
}

export function summarizeHealth(healths: readonly DeviceHealth[], latestVersion: string | null): HealthSummary {
  const summary: HealthSummary = { recording: 0, idle: 0, attention: 0, not_recording: 0, latest_version: latestVersion };
  for (const h of healths) {
    if (h.state === 'attention') summary.attention++;
    else if (h.state === 'not_recording') summary.not_recording++;
    else if (h.idle) summary.idle++;
    else summary.recording++;
  }
  return summary;
}
