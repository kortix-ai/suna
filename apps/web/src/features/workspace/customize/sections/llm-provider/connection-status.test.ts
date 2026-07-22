import { describe, expect, test } from 'bun:test';

import {
  CONNECTION_STATUS,
  connectionStatusBadge,
  credentialStatusBadge,
  runtimeStatusBadge,
} from './connection-status';

describe('connectionStatusBadge', () => {
  test('resolves every connection status into a canonical badge', () => {
    expect(connectionStatusBadge('ready')).toEqual(CONNECTION_STATUS.connected);
    expect(connectionStatusBadge('needs-attention')).toEqual(CONNECTION_STATUS.needsAttention);
    expect(connectionStatusBadge('unavailable')).toEqual(CONNECTION_STATUS.unavailable);
    expect(connectionStatusBadge('checking')).toEqual(CONNECTION_STATUS.checking);
  });
});

describe('runtimeStatusBadge — one vocabulary shared with the connection rows', () => {
  test('the four connection-shared states map straight through connectionStatusBadge', () => {
    expect(runtimeStatusBadge('ready')).toEqual(CONNECTION_STATUS.connected);
    expect(runtimeStatusBadge('checking')).toEqual(CONNECTION_STATUS.checking);
    expect(runtimeStatusBadge('needs-attention')).toEqual(CONNECTION_STATUS.needsAttention);
    expect(runtimeStatusBadge('unavailable')).toEqual(CONNECTION_STATUS.unavailable);
  });

  test('the two runtime-only states both collapse to the single "Not connected" word', () => {
    // The old jargon ("Choose connection" / "Needs connection") is gone — a
    // user reads one honest phrase for "nothing is connected yet".
    expect(runtimeStatusBadge('ambiguous')).toEqual(CONNECTION_STATUS.notConnected);
    expect(runtimeStatusBadge('missing')).toEqual(CONNECTION_STATUS.notConnected);
    expect(CONNECTION_STATUS.notConnected.label).toBe('Not connected');
  });

  test('never emits the retired "Choose connection" / "Needs connection" jargon', () => {
    const labels = (['ready', 'checking', 'missing', 'ambiguous', 'needs-attention', 'unavailable'] as const).map(
      (status) => runtimeStatusBadge(status).label,
    );
    expect(labels).not.toContain('Choose connection');
    expect(labels).not.toContain('Needs connection');
  });
});

describe('credentialStatusBadge — typed CredentialRecord health, same vocabulary', () => {
  test('maps every typed status into the shared badge set (absent = no badge)', () => {
    expect(credentialStatusBadge('healthy')).toEqual(CONNECTION_STATUS.connected);
    expect(credentialStatusBadge('expired')).toEqual(CONNECTION_STATUS.expired);
    expect(credentialStatusBadge('invalid')).toEqual(CONNECTION_STATUS.needsAttention);
    expect(credentialStatusBadge('unverified')).toEqual(CONNECTION_STATUS.checking);
    expect(credentialStatusBadge('absent')).toBeNull();
  });
});
