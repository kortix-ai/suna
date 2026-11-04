import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanOsVersion, deviceDiagnostics, osNameFromVersion, parseUpdate, type DiagnosticsInput } from './diagnostics';
import { deviceFields } from './format';

/** The committed format fixtures: the same files the app's schema test validates. */
const FIXTURE = join(import.meta.dir, '../../../capture/fixtures/capture-format-v2/bucket/fixture-prefix/0f1e2d3c4b5a69788796a5b4c3d2e1f0');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Record<string, unknown>;

const row = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  os: 'macos',
  osVersion: '26.0',
  arch: 'aarch64',
  appVersion: '0.1.0',
  deviceInfo: {},
  status: null,
  statusReportedAt: null,
  lastCredentialsAt: null,
  enrollmentTokenId: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  ...over,
});

describe('deviceDiagnostics', () => {
  test('reads every section from the format fixtures', () => {
    const d = deviceDiagnostics(row({ deviceInfo: fixture('device.json'), status: fixture('status.json'), enrollmentTokenId: '00000000-0000-4000-8000-000000000001' }));
    expect(d.os).toEqual({ family: 'macos', name: 'macOS 26.0', version: '26.0', build: '25A354', arch: 'aarch64' });
    expect(d.hostname).toBe('fixture-host.local');
    expect(d.member_email).toBe('person@example.com');
    expect(d.machine).toMatchObject({ cpu: 'Apple M3 Pro', cpu_cores: 12, memory_bytes: 38654705664, gpus: [], timezone: 'Europe/Berlin', locale: 'en-US' });
    expect(d.update).toMatchObject({ status: 'current', installed: '0.1.0', latest: '0.1.0', last_check: 'up to date (0.1.0; newest is 0.1.0)', skipped: [] });
    expect(d.update?.last_result).toEqual({ at: new Date(1790841900000).toISOString(), from: '0.0.9', to: '0.1.0', outcome: 'updated', detail: null });
    expect(d.recording).toMatchObject({ state: 'recording', reason: null, actions_recording: true, audio_enabled: false });
    expect(d.sync).toEqual({ state: 'off', pending: null, error_class: null, last_upload_at: null });
    expect(d.policy?.source).toBe('fixture-prefix/policy.json');
    expect(d.managed).toBe(true);
    expect(d.encrypted).toBe(false);
  });

  test('a failed update keeps its reason and when the skipped version is tried again', () => {
    const update = {
      status: 'failed', installed: '0.1.0', channel: 'stable', latest: '0.1.1', lastCheckMs: 1790845300000,
      lastCheck: 'no update: 0.1.1 is marked bad on this computer', updatingTo: null,
      lastResult: { at_ms: 1790845000000, from: '0.1.0', to: '0.1.1', outcome: 'rolled_back', detail: '0.1.1 did not report healthy in 900 s: session 2: no_new_frame (state recording, last frame 41 s before the install)' },
      badVersions: ['0.1.1'], skipped: [{ version: '0.1.1', failedAtMs: 1790845000000, retryAtMs: 1791449800000 }],
    };
    const d = deviceDiagnostics(row({ status: { ...fixture('status.json'), update } }));
    expect(d.update).toMatchObject({ status: 'failed', latest: '0.1.1', last_check: 'no update: 0.1.1 is marked bad on this computer' });
    expect(d.update?.last_result).toMatchObject({ outcome: 'rolled_back', to: '0.1.1' });
    expect(d.update?.last_result?.detail).toContain('session 2: no_new_frame');
    expect(d.update?.skipped).toEqual([{ version: '0.1.1', failed_at: new Date(1790845000000).toISOString(), retry_at: new Date(1791449800000).toISOString() }]);
  });

  test('an older app (no machine report, no update block) answers every key with null', () => {
    const d = deviceDiagnostics(row({ os: 'windows', osVersion: 'Microsoft Windows [Version 10.0.26200.9448]', arch: 'x86_64' }));
    expect(d.os).toEqual({ family: 'windows', name: 'Windows 11', version: '10.0.26200.9448', build: '26200.9448', arch: 'x86_64' });
    expect(d.machine).toBeNull();
    expect(d.update).toBeNull();
    expect(d.policy).toBeNull();
    expect(d.recording.missing_permissions).toEqual([]);
    expect(d.reported_at).toBeNull();
  });

  test('a masked device has no hostname, and junk values are dropped, not passed through', () => {
    const d = deviceDiagnostics(
      row({
        deviceInfo: { hostname: null, computer_name: null, encryption: { alg: 'aes-256-gcm', key_id: 'k1' }, machine: { cpu: 42, gpus: ['GPU A', 7, ''], cpu_cores: '8' } },
        status: { update: { status: 'exploded', badVersions: ['0.1.1'] }, missingPermissions: ['screen_recording', 3], reason: 'error', lastError: 'capture_failed: AcquireNextFrame' },
      }),
    );
    expect(d.hostname).toBeNull();
    expect(d.encrypted).toBe(true);
    expect(d.machine).toMatchObject({ cpu: null, cpu_cores: null, gpus: ['GPU A'] });
    expect(d.update).toMatchObject({ status: 'unknown', skipped: [{ version: '0.1.1', failed_at: null, retry_at: null }] });
    expect(d.recording.missing_permissions).toEqual(['screen_recording']);
    expect(d.recording).toMatchObject({ reason: 'error', last_error: 'capture_failed: AcquireNextFrame' });
  });

  test('answers null for a timestamp past the Date range instead of throwing', () => {
    const d = deviceDiagnostics(row({ status: { lastFrameMs: 1e21, pausedUntilMs: 8.64e15 + 1, host: { awakeSinceMs: 1e300 } } }));
    expect(d.recording).toMatchObject({ last_frame_at: null, paused_until: null, awake_since: null });
  });
});

describe('OS names', () => {
  test('the raw Windows ver line becomes the version number, on read and on store', () => {
    expect(cleanOsVersion('Microsoft Windows [Version 10.0.26200.9448]')).toBe('10.0.26200.9448');
    expect(cleanOsVersion('26.0')).toBe('26.0');
    expect(cleanOsVersion('  ')).toBeNull();
    expect(deviceFields({ os: 'windows', os_version: 'Microsoft Windows [Version 10.0.19045.5011]' }).osVersion).toBe('10.0.19045.5011');
  });

  test('Windows 11 is build 22000 and up', () => {
    expect(osNameFromVersion('windows', '10.0.22000')).toEqual({ name: 'Windows 11', build: '22000' });
    expect(osNameFromVersion('windows', '10.0.19045.5011')).toEqual({ name: 'Windows 10', build: '19045.5011' });
    expect(osNameFromVersion('linux', 'Ubuntu 24.04.1 LTS')).toEqual({ name: 'Ubuntu 24.04.1 LTS', build: null });
  });

  test('parseUpdate is null without a machine service', () => {
    expect(parseUpdate(null)).toBeNull();
    expect(parseUpdate('failed')).toBeNull();
  });
});
