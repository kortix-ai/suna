import { describe, expect, test } from 'bun:test';
import type { CaptureDevice, CaptureDeviceDiagnostics } from '@kortix/sdk';

import { deviceOs } from '@kortix/ui/internal/capture/use-capture-area';

import { diagnosticsText, formatBytes, versionView } from './device-diagnostics';
import { deviceStatus } from './device-status';

const diagnostics = (over: Partial<CaptureDeviceDiagnostics> = {}): CaptureDeviceDiagnostics => ({
  os: { family: 'windows', name: 'Windows 11 Pro 24H2', version: '10.0.26200.9448', build: '26200.9448', arch: 'x86_64' },
  hostname: 'fixture-pc',
  computer_name: 'Fixture PC',
  member_email: 'person@example.com',
  app_version: '0.1.0',
  update: {
    status: 'failed',
    installed: '0.1.0',
    channel: 'stable',
    latest: '0.1.1',
    last_check_at: '2026-11-04T10:00:00.000Z',
    last_check: 'no update: 0.1.1 is marked bad on this computer',
    updating_to: null,
    last_result: { at: '2026-11-04T09:00:00.000Z', from: '0.1.0', to: '0.1.1', outcome: 'rolled_back', detail: '0.1.1 did not report healthy in 900 s: session 2: no_new_frame' },
    skipped: [{ version: '0.1.1', failed_at: '2026-11-04T09:00:00.000Z', retry_at: '2026-11-11T09:00:00.000Z' }],
  },
  recording: {
    state: 'recording', reason: null, last_error: null, missing_permissions: [], last_frame_at: '2026-11-04T10:00:00.000Z', paused_until: null,
    awake_since: null, interval_ms: 1000, max_height: 1080, audio_enabled: false, actions_recording: true, displays: 2,
  },
  sync: { state: 'ok', pending: 0, error_class: null, last_upload_at: '2026-11-04T10:00:00.000Z' },
  policy: { source: 'prefix/policy.json', updated_at: null, fetched_at: '2026-11-04T10:00:00.000Z' },
  machine: {
    cpu: 'Synthetic CPU', cpu_cores: 8, memory_bytes: 17179869184, disk_free_bytes: 107374182400, disk_total_bytes: 536870912000,
    gpus: ['Synthetic GPU'], booted_at: '2026-11-04T08:00:00.000Z', timezone: 'W. Europe Standard Time', utc_offset: '+01:00', locale: 'de-DE',
  },
  encrypted: false,
  managed: true,
  described_at: '2026-11-04T09:30:00.000Z',
  reported_at: '2026-11-04T10:00:15.000Z',
  last_credentials_at: null,
  created_at: '2026-11-01T00:00:00.000Z',
  ...over,
});

const device = (d: CaptureDeviceDiagnostics | undefined, reasons: string[] = [], latest: string | null = null) =>
  ({
    device_id: '00000000-0000-4000-8000-0000000000d1',
    os: 'windows',
    os_version: '10.0.26200.9448',
    arch: 'x86_64',
    app_version: '0.1.0',
    live: { state: 'recording', status: {}, reported_at: '2026-11-04T10:00:15.000Z' },
    last_credentials_at: null,
    enrollment_token_id: null,
    created_at: '2026-11-01T00:00:00.000Z',
    health: { state: reasons.length ? 'attention' : 'healthy', idle: false, reasons, since: null, latest_version: latest },
    diagnostics: d,
  }) as unknown as CaptureDevice;

describe('versionView', () => {
  test('a failed update names the version it could not reach', () => {
    expect(versionView(device(diagnostics(), ['update_failed', 'behind_version'], '0.1.1'))).toEqual({ version: '0.1.0', state: 'failed', latest: '0.1.1' });
  });

  test('behind, current, and an older API without diagnostics', () => {
    const behind = diagnostics({ update: { ...diagnostics().update!, status: 'behind', last_result: null } });
    expect(versionView(device(behind, ['behind_version'], '0.1.2'))).toEqual({ version: '0.1.0', state: 'behind', latest: '0.1.2' });
    const current = diagnostics({ update: { ...diagnostics().update!, status: 'current' } });
    expect(versionView(device(current)).state).toBe('current');
    expect(versionView(device(undefined))).toEqual({ version: '0.1.0', state: null, latest: null });
    expect(versionView(device(undefined, ['behind_version'], '0.2.0'))).toEqual({ version: '0.1.0', state: 'behind', latest: '0.2.0' });
  });

  test('the health line of a failed update carries the target version', () => {
    expect(deviceStatus(device(diagnostics(), ['update_failed'])).health).toEqual([{ code: 'update_failed', version: '0.1.1' }]);
  });
});

describe('diagnosticsText', () => {
  test('one fact per line, with the update reason, machine and sync', () => {
    const text = diagnosticsText(device(diagnostics(), ['update_failed']), 'Fixture PC');
    const lines = text.split('\n');
    expect(lines[0]).toBe('Kortix Capture diagnostics');
    expect(lines).toContain('device_id: 00000000-0000-4000-8000-0000000000d1');
    expect(lines).toContain('update: failed (installed 0.1.0, latest 0.1.1, channel stable)');
    expect(lines).toContain('update_last_result: rolled_back 0.1.0 -> 0.1.1 at 2026-11-04T09:00:00.000Z: 0.1.1 did not report healthy in 900 s: session 2: no_new_frame');
    expect(lines).toContain('update_skipped: 0.1.1 (retry 2026-11-11T09:00:00.000Z)');
    expect(lines).toContain('os: Windows 11 Pro 24H2 (build 26200.9448, x86_64)');
    expect(lines).toContain('cpu: Synthetic CPU (8 cores)');
    expect(lines).toContain('memory: 16.0 GB');
    expect(lines).toContain('disk_free: 100.0 GB of 500.0 GB');
    expect(lines).toContain('timezone: W. Europe Standard Time (+01:00)');
    expect(lines).toContain('sync: ok, 0 pending, error none, last upload 2026-11-04T10:00:00.000Z');
    expect(lines).toContain('health: attention: update_failed');
    expect(lines).toContain('managed: yes (enrollment token)');
  });

  test('an older app says what it did not report instead of leaving blanks', () => {
    const text = diagnosticsText(device(diagnostics({ update: null, machine: null })), 'Fixture PC');
    expect(text).toContain('update: not reported (no machine service)');
    expect(text).toContain('machine: not reported (app version before the machine report)');
    expect(diagnosticsText(device(undefined), 'Fixture PC')).toContain('os: windows 10.0.26200.9448 (build ?, x86_64)');
  });

  test('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });
});

describe('deviceOs', () => {
  test('Windows reads as 10 or 11 by build, also from the raw ver line an older app sent', () => {
    expect(deviceOs({ os: 'windows', os_version: '10.0.26200.9448' })).toBe('Windows 11');
    expect(deviceOs({ os: 'windows', os_version: 'Microsoft Windows [Version 10.0.26200.9448]' })).toBe('Windows 11');
    expect(deviceOs({ os: 'windows', os_version: '10.0.19045.5011' })).toBe('Windows 10');
    expect(deviceOs({ os: 'windows', os_version: null })).toBe('Windows');
    expect(deviceOs({ os: 'macos', os_version: '26.0' })).toBe('macOS 26.0');
    expect(deviceOs({ os: 'linux', os_version: 'Ubuntu 24.04.1 LTS' })).toBe('Ubuntu 24.04.1 LTS');
    expect(deviceOs({ os: 'linux', os_version: null })).toBe('Linux');
  });
});
