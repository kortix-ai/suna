/**
 * One Kortix Capture device's diagnostics: everything support needs to see in
 * one typed object, read from the device's last `device.json` (`device_info`)
 * and `status.json` (`status`), both in the Kortix Capture format, schema 2
 * (.agents/skills/kortix-capture/references/capture-format.md). Pure: the
 * devices answer (reads.ts) calls it per row. A field the device did not send
 * is null, so an older app version still answers every key.
 */

export type UpdateStatus = 'current' | 'behind' | 'updating' | 'failed' | 'disabled' | 'unknown';
export type UpdateOutcome = 'updated' | 'rolled_back' | 'failed' | 'install_failed';

export interface DiagnosticsUpdate {
  /** `failed`: the newest release did not install here; `last_result.detail` says why. */
  status: UpdateStatus;
  installed: string | null;
  channel: string | null;
  latest: string | null;
  last_check_at: string | null;
  /** What the last check did, in the app's words ("up to date (0.14.17; newest is 0.14.17)"). */
  last_check: string | null;
  updating_to: string | null;
  last_result: { at: string | null; from: string | null; to: string | null; outcome: UpdateOutcome | string; detail: string | null } | null;
  /** Versions that failed here and are not tried again before `retry_at`. */
  skipped: { version: string; failed_at: string | null; retry_at: string | null }[];
}

export interface DiagnosticsMachine {
  cpu: string | null;
  cpu_cores: number | null;
  memory_bytes: number | null;
  disk_free_bytes: number | null;
  disk_total_bytes: number | null;
  gpus: string[];
  booted_at: string | null;
  timezone: string | null;
  utc_offset: string | null;
  locale: string | null;
}

export interface DeviceDiagnostics {
  os: { family: string | null; name: string | null; version: string | null; build: string | null; arch: string | null };
  /** Null when the device masks it (encryption or local PII masking on). */
  hostname: string | null;
  computer_name: string | null;
  member_email: string | null;
  app_version: string | null;
  /** Null on a computer without the machine service (a person's own install before 0.14). */
  update: DiagnosticsUpdate | null;
  recording: {
    state: string | null;
    reason: string | null;
    /** While `reason` is `error`: the recorder's last capture error (app 0.14.20 and later). */
    last_error: string | null;
    missing_permissions: string[];
    last_frame_at: string | null;
    paused_until: string | null;
    awake_since: string | null;
    interval_ms: number | null;
    max_height: number | null;
    audio_enabled: boolean | null;
    actions_recording: boolean | null;
    displays: number;
  };
  sync: { state: string | null; pending: number | null; error_class: string | null; last_upload_at: string | null };
  policy: { source: string | null; updated_at: string | null; fetched_at: string | null } | null;
  /** Null from an app version before the machine report. */
  machine: DiagnosticsMachine | null;
  encrypted: boolean;
  /** Enrolled by IT with an enrollment token. */
  managed: boolean;
  /** When the device last wrote device.json and status.json. */
  described_at: string | null;
  reported_at: string | null;
  last_credentials_at: string | null;
  created_at: string;
}

export interface DiagnosticsInput {
  os: string | null;
  osVersion: string | null;
  arch: string | null;
  appVersion: string | null;
  deviceInfo: Record<string, unknown> | null;
  status: Record<string, unknown> | null;
  statusReportedAt: Date | null;
  lastCredentialsAt: Date | null;
  enrollmentTokenId: string | null;
  createdAt: Date;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown, max = 500): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const iso = (ms: unknown): string | null => {
  const n = num(ms);
  // A device sends these: past the Date range (8.64e15 ms) toISOString throws and
  // one bad status.json would fail the whole devices answer.
  return n !== null && n > 0 && n <= 8.64e15 ? new Date(n).toISOString() : null;
};
const strings = (value: unknown, max = 20): string[] =>
  Array.isArray(value) ? value.map((v) => text(v, 200)).filter((v): v is string => v !== null).slice(0, max) : [];

const UPDATE_STATUSES = new Set<UpdateStatus>(['current', 'behind', 'updating', 'failed', 'disabled']);

/** `Microsoft Windows [Version 10.0.26200.9448]` (the raw `ver` line older apps sent) → `10.0.26200.9448`. */
export function cleanOsVersion(raw: string | null | undefined): string | null {
  const value = text(raw, 200);
  if (!value) return null;
  return /\[Version ([^\]]+)\]/.exec(value)?.[1]?.trim() ?? value;
}

/**
 * The OS name and build when the device sent no `machine` report. Windows 11
 * still reports version 10.0; build 22000 and up is Windows 11.
 */
export function osNameFromVersion(os: string | null, version: string | null): { name: string | null; build: string | null } {
  const family = os?.toLowerCase();
  if (family === 'windows') {
    const parts = /^10\.0\.(\d+)(?:\.(\d+))?/.exec(version ?? '');
    if (!parts) return { name: 'Windows', build: version };
    return { name: Number(parts[1]) >= 22000 ? 'Windows 11' : 'Windows 10', build: parts[2] ? `${parts[1]}.${parts[2]}` : parts[1]! };
  }
  if (family === 'macos') return { name: version ? `macOS ${version}` : 'macOS', build: null };
  if (family === 'linux') return { name: version || 'Linux', build: null };
  return { name: os, build: null };
}

/** status.json `update`, parsed into a stable shape; null when the device has no machine service. */
export function parseUpdate(raw: unknown): DiagnosticsUpdate | null {
  const u = record(raw);
  if (!u) return null;
  const status = text(u.status) as UpdateStatus | null;
  const last = record(u.lastResult);
  const skippedRaw = Array.isArray(u.skipped) ? u.skipped : [];
  const skipped = skippedRaw.length
    ? skippedRaw.map(record).filter((s): s is Record<string, unknown> => s !== null && text(s.version) !== null)
        .map((s) => ({ version: text(s.version)!, failed_at: iso(s.failedAtMs), retry_at: iso(s.retryAtMs) }))
    : strings(u.badVersions).map((version) => ({ version, failed_at: null, retry_at: null }));
  return {
    status: status && UPDATE_STATUSES.has(status) ? status : 'unknown',
    installed: text(u.installed),
    channel: text(u.channel),
    latest: text(u.latest),
    last_check_at: iso(u.lastCheckMs),
    last_check: text(u.lastCheck, 1000),
    updating_to: text(u.updatingTo),
    last_result: last
      ? { at: iso(last.at_ms), from: text(last.from), to: text(last.to), outcome: text(last.outcome) ?? 'unknown', detail: text(last.detail, 2000) }
      : null,
    skipped: skipped.slice(0, 20),
  };
}

function parseMachine(raw: unknown): DiagnosticsMachine | null {
  const m = record(raw);
  if (!m) return null;
  return {
    cpu: text(m.cpu, 200),
    cpu_cores: num(m.cpu_cores),
    memory_bytes: num(m.memory_bytes),
    disk_free_bytes: num(m.disk_free_bytes),
    disk_total_bytes: num(m.disk_total_bytes),
    gpus: strings(m.gpus, 8),
    booted_at: iso(m.booted_at_ms),
    timezone: text(m.timezone, 100),
    utc_offset: text(m.utc_offset, 10),
    locale: text(m.locale, 40),
  };
}

export function deviceDiagnostics(device: DiagnosticsInput): DeviceDiagnostics {
  const info = record(device.deviceInfo) ?? {};
  const status = record(device.status) ?? {};
  const machine = record(info.machine);
  const sync = record(status.sync) ?? {};
  const capture = record(status.capture);
  const policy = record(status.policy);
  const version = cleanOsVersion(device.osVersion ?? text(info.os_version));
  const derived = osNameFromVersion(device.os, version);
  return {
    os: {
      family: device.os,
      name: text(machine?.os_name, 200) ?? derived.name,
      version,
      build: text(machine?.os_build, 100) ?? derived.build,
      arch: device.arch,
    },
    hostname: text(info.hostname, 200),
    computer_name: text(info.computer_name, 200),
    member_email: text(record(info.member)?.email, 320),
    app_version: text(status.appVersion) ?? device.appVersion,
    update: parseUpdate(status.update),
    recording: {
      state: text(status.recording),
      reason: text(status.reason),
      last_error: text(status.lastError, 300),
      missing_permissions: strings(status.missingPermissions),
      last_frame_at: iso(status.lastFrameMs),
      paused_until: iso(status.pausedUntilMs),
      awake_since: iso(record(status.host)?.awakeSinceMs),
      interval_ms: num(capture?.intervalMs),
      max_height: num(capture?.maxHeight),
      audio_enabled: bool(record(status.audio)?.enabled),
      actions_recording: bool(status.actionsRecording),
      displays: Array.isArray(status.displays) ? status.displays.length : Array.isArray(info.displays) ? info.displays.length : 0,
    },
    sync: { state: text(sync.state), pending: num(sync.pending), error_class: text(sync.errorClass), last_upload_at: iso(sync.lastUploadMs) },
    policy: policy ? { source: text(policy.source), updated_at: iso(policy.updatedAtMs), fetched_at: iso(policy.fetchedAtMs) } : null,
    machine: parseMachine(machine),
    encrypted: record(info.encryption) !== null,
    managed: device.enrollmentTokenId !== null,
    described_at: iso(info.updated_at_ms),
    reported_at: device.statusReportedAt?.toISOString() ?? iso(status.reportedAtMs),
    last_credentials_at: device.lastCredentialsAt?.toISOString() ?? null,
    created_at: device.createdAt.toISOString(),
  };
}
