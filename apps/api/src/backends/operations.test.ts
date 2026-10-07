import { describe, expect, test } from 'bun:test';

const {
  AUTOMATIC_SNAPSHOT_INTERVAL_MS,
  AUTOMATIC_SNAPSHOT_RETRY_MS,
  OPERATION_STALE_MS,
  automaticSnapshotDue,
  backendOperation,
  expiredSnapshotIds,
} = await import('./operations');
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
    expect(backendOperation(row({ operation: 'snapshotting', ...longRunning }), now)).toBe('snapshotting');
    expect(backendOperation(row({ operation: 'restoring', ...longRunning }), now)).toBe('restoring');
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

describe('automaticSnapshotDue', () => {
  test('due 24 h after the last automatic snapshot, or after creation; a failed try waits 1 h', () => {
    const created = (ms: number) => ({ createdAt: new Date(now - ms) });
    expect(automaticSnapshotDue(row({}, created(AUTOMATIC_SNAPSHOT_INTERVAL_MS - 1)), now)).toBe(false);
    expect(automaticSnapshotDue(row({}, created(AUTOMATIC_SNAPSHOT_INTERVAL_MS)), now)).toBe(true);
    const old = created(10 * AUTOMATIC_SNAPSHOT_INTERVAL_MS);
    expect(automaticSnapshotDue(row({ lastAutomaticSnapshotAt: at(60_000) }, old), now)).toBe(false);
    expect(automaticSnapshotDue(row({ lastAutomaticSnapshotAt: at(AUTOMATIC_SNAPSHOT_INTERVAL_MS) }, old), now)).toBe(true);
    expect(automaticSnapshotDue(row({ automaticSnapshotAttemptAt: at(AUTOMATIC_SNAPSHOT_RETRY_MS - 1) }, old), now)).toBe(false);
    expect(automaticSnapshotDue(row({ automaticSnapshotAttemptAt: at(AUTOMATIC_SNAPSHOT_RETRY_MS) }, old), now)).toBe(true);
  });
});

describe('expiredSnapshotIds', () => {
  const label = (kind: string, ms: number) => ({ kind, expiresAt: at(ms) });
  test('expired resize snapshots go; an expired automatic one only when a newer automatic exists', () => {
    expect(expiredSnapshotIds(row({}), now)).toEqual([]);
    expect(
      expiredSnapshotIds(
        row({
          snapshotLabels: {
            'r-expired': label('resize', 1),
            'r-live': label('resize', -60_000),
            'a-expired': label('automatic', 2 * 86_400_000),
            'a-newest-expired': label('automatic', 86_400_000),
          },
        }),
        now,
      ),
    ).toEqual(['r-expired', 'a-expired']);
    // The only automatic snapshot outlives its expiry.
    expect(expiredSnapshotIds(row({ snapshotLabels: { a: label('automatic', 86_400_000) } }), now)).toEqual([]);
  });
});
