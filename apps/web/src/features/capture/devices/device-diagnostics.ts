/**
 * A device's version state and its diagnostics as plain text, from the
 * `diagnostics` object of the devices answer (`CaptureDeviceDiagnostics`) and
 * its health reasons. The copied text is a support artifact: stable English
 * keys, ISO times, one fact per line, so it reads the same in every locale.
 */
import type { CaptureDevice, CaptureUpdateStatus } from '@kortix/sdk';

export type VersionState = 'current' | 'behind' | 'failed' | 'updating' | 'disabled' | null;

export interface VersionView {
  /** The version the device runs; null before it reports one. */
  version: string | null;
  /** null: the device reports no update state (no machine service) and is not behind. */
  state: VersionState;
  /** The newest release, when the device is behind it or failed to reach it. */
  latest: string | null;
}

const FROM_UPDATE: Partial<Record<CaptureUpdateStatus, VersionState>> = {
  current: 'current',
  behind: 'behind',
  failed: 'failed',
  updating: 'updating',
  disabled: 'disabled',
};

export function versionView(device: CaptureDevice): VersionView {
  const update = device.diagnostics?.update ?? null;
  const reasons = device.health?.reasons ?? [];
  const version = device.diagnostics?.app_version ?? device.app_version ?? null;
  const failed = reasons.includes('update_failed') || update?.status === 'failed';
  const behind = reasons.includes('behind_version') || update?.status === 'behind';
  const state: VersionState = failed ? 'failed' : behind ? 'behind' : update ? (FROM_UPDATE[update.status] ?? null) : null;
  const latest =
    state === 'failed'
      ? (update?.last_result?.to ?? update?.latest ?? device.health?.latest_version ?? null)
      : state === 'behind'
        ? (device.health?.latest_version ?? update?.latest ?? null)
        : null;
  return { version, state, latest };
}

/** `17179869184` → `16.0 GB`. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

const or = (value: string | number | null | undefined, fallback = 'none') =>
  value === null || value === undefined || value === '' ? fallback : String(value);

/** The diagnostics as a plain-text block for a support request. */
export function diagnosticsText(device: CaptureDevice, name: string): string {
  const d = device.diagnostics;
  const lines: [string, string][] = [
    ['device_id', device.device_id],
    ['name', name],
    ['member', or(d?.member_email)],
    ['hostname', or(d?.hostname, 'masked or not reported')],
    ['app_version', or(d?.app_version ?? device.app_version, 'not reported')],
  ];
  const u = d?.update;
  if (u) {
    lines.push(['update', `${u.status} (installed ${or(u.installed)}, latest ${or(u.latest)}, channel ${or(u.channel)})`]);
    if (u.updating_to) lines.push(['update_updating_to', u.updating_to]);
    lines.push(['update_last_check', `${or(u.last_check_at, 'never')}: ${or(u.last_check)}`]);
    const r = u.last_result;
    lines.push([
      'update_last_result',
      r ? `${r.outcome} ${or(r.from, '?')} -> ${or(r.to, '?')} at ${or(r.at, '?')}${r.detail ? `: ${r.detail}` : ''}` : 'none',
    ]);
    lines.push(['update_skipped', u.skipped.length ? u.skipped.map((s) => `${s.version} (retry ${or(s.retry_at, 'unknown')})`).join(', ') : 'none']);
  } else {
    lines.push(['update', 'not reported (no machine service)']);
  }
  const os = d?.os;
  const osName = os?.name ?? [device.os, device.os_version].filter(Boolean).join(' ');
  lines.push(['os', `${or(osName, 'not reported')} (build ${or(os?.build, '?')}, ${or(os?.arch ?? device.arch, '?')})`]);
  const m = d?.machine;
  if (m) {
    lines.push(['cpu', `${or(m.cpu, 'not reported')}${m.cpu_cores ? ` (${m.cpu_cores} cores)` : ''}`]);
    lines.push(['memory', or(formatBytes(m.memory_bytes), 'not reported')]);
    lines.push(['disk_free', `${or(formatBytes(m.disk_free_bytes), '?')} of ${or(formatBytes(m.disk_total_bytes), '?')}`]);
    lines.push(['gpus', m.gpus.length ? m.gpus.join(', ') : 'not reported']);
    lines.push(['booted', or(m.booted_at, 'not reported')]);
    lines.push(['timezone', `${or(m.timezone, '?')} (${or(m.utc_offset, '?')})`]);
    lines.push(['locale', or(m.locale, 'not reported')]);
  } else {
    lines.push(['machine', 'not reported (app version before the machine report)']);
  }
  const rec = d?.recording;
  lines.push(['recording', `${or(rec?.state ?? device.live.state, 'unknown')} (reason ${or(rec?.reason)})`]);
  if (rec?.last_error) lines.push(['recording_error', rec.last_error]);
  lines.push(['missing_permissions', rec?.missing_permissions.length ? rec.missing_permissions.join(', ') : 'none']);
  lines.push(['last_frame', or(rec?.last_frame_at, 'never')]);
  if (rec?.interval_ms && rec.max_height) lines.push(['capture', `every ${rec.interval_ms} ms, ${rec.max_height}p, ${rec.displays} display(s)`]);
  const s = d?.sync;
  lines.push(['sync', s ? `${or(s.state, 'unknown')}, ${s.pending ?? 0} pending, error ${or(s.error_class)}, last upload ${or(s.last_upload_at, 'never')}` : 'not reported']);
  const p = d?.policy;
  lines.push(['policy', p ? `${or(p.source)}, updated ${or(p.updated_at, '?')}, read ${or(p.fetched_at, '?')}` : 'none']);
  lines.push(['health', `${device.health?.state ?? 'unknown'}${device.health?.reasons.length ? `: ${device.health.reasons.join(', ')}` : ''}`]);
  lines.push(['managed', d?.managed || device.enrollment_token_id ? 'yes (enrollment token)' : 'no (signed in by the person)']);
  lines.push(['encrypted', d?.encrypted ? 'yes' : 'no']);
  lines.push(['reported', or(d?.reported_at ?? device.live.reported_at, 'never')]);
  lines.push(['described', or(d?.described_at, 'never')]);
  lines.push(['last_credentials', or(d?.last_credentials_at ?? device.last_credentials_at, 'never')]);
  lines.push(['created', device.created_at]);
  return ['Kortix Capture diagnostics', ...lines.map(([k, v]) => `${k}: ${v}`)].join('\n');
}
