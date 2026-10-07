import { describe, expect, test } from 'bun:test';

const { OPERATION_STALE_MS, backendOperation } = await import('./operations');
const { PROVISION_STALE_MS, effectiveStatus } = await import('./provision');

const row = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ metadata, createdAt: new Date(now - 3_600_000), ...extra }) as never;
const now = Date.parse('2026-10-07T00:00:00.000Z');
const at = (ms: number) => new Date(now - ms).toISOString();

describe('backendOperation', () => {
  test('a fresh resize is in flight; idle and stale ones are not', () => {
    expect(backendOperation(row({}), now)).toBeNull();
    expect(backendOperation(row({ operation: 'resizing', operationStartedAt: at(60_000) }), now)).toBe('resizing');
    // The API process that ran it died: the marker must not block the backend forever.
    expect(backendOperation(row({ operation: 'resizing', operationStartedAt: at(OPERATION_STALE_MS + 1) }), now)).toBeNull();
    expect(backendOperation(row({ operation: 'resizing' }), now)).toBe('resizing');
  });

  test('the heartbeat, not the start, decides staleness; every operation kind is reported', () => {
    const longRunning = { operationStartedAt: at(30 * 60_000), heartbeatAt: at(10_000) };
    expect(backendOperation(row({ operation: 'rotating_key', ...longRunning }), now)).toBe('rotating_key');
    expect(backendOperation(row({ operation: 'recovering', ...longRunning }), now)).toBe('recovering');
    expect(
      backendOperation(row({ operation: 'resizing', operationStartedAt: at(60_000), heartbeatAt: at(OPERATION_STALE_MS + 1) }), now),
    ).toBeNull();
    expect(backendOperation(row({ operation: 'unknown-kind', heartbeatAt: at(0) }), now)).toBeNull();
  });
});

describe('effectiveStatus', () => {
  test('a provisioning row reads error only after PROVISION_STALE_MS without a heartbeat', () => {
    const provisioning = (metadata: Record<string, unknown>) => row(metadata, { status: 'provisioning' });
    // Created an hour ago, but it heartbeat 10 s ago: a long first image build or a resumed provision.
    expect(effectiveStatus(provisioning({ heartbeatAt: at(10_000) }), now)).toBe('provisioning');
    expect(effectiveStatus(provisioning({ heartbeatAt: at(PROVISION_STALE_MS + 1) }), now)).toBe('error');
    // No heartbeat yet: the creation time counts.
    expect(effectiveStatus(provisioning({}), now)).toBe('error');
    expect(effectiveStatus(row({}, { status: 'provisioning', createdAt: new Date(now - 5_000) }), now)).toBe('provisioning');
    expect(effectiveStatus(row({}, { status: 'running' }), now)).toBe('running');
  });
});
