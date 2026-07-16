/**
 * Unit tests for backend.buildSandboxUpstreamHeaders — the single header
 * builder shared by the HTTP forwarder and the WebSocket upstream resolver.
 * Both edges must produce an identical auth/identity header set, so this is
 * the contract that keeps them from drifting apart again.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

let mockPayload: { userId: string; sandboxId: string } | null = null;

mock.module('../config', () => ({
  config: {},
  SANDBOX_VERSION: 'test-version',
}));
mock.module('../shared/db', () => ({ db: {} }));
mock.module('../shared/daytona', () => ({
  getDaytona: () => ({}),
  archiveDaytonaSandboxById: async () => ({ ok: true }),
  isDaytonaDiskQuotaError: () => false,
  listStoppedDaytonaSandboxesOldestFirst: async function* () {},
}));
mock.module('../projects/disk-quota-guard', () => ({
  triggerEmergencyDiskArchiveSweep: () => {},
}));
mock.module('../shared/preview-ownership', () => ({
  resolvePreviewUserContext: async (sandboxId: string, userId?: string) =>
    mockPayload ? { ...mockPayload, sandboxId, userId } : null,
}));
mock.module('../shared/kortix-user-context', () => ({
  KORTIX_USER_CONTEXT_HEADER: 'X-Kortix-User-Context',
  encodeKortixUserContext: (payload: any, key: string) => `signed:${key}:${payload.userId}`,
}));

const { buildSandboxUpstreamHeaders } = await import('../sandbox-proxy/backend');

beforeEach(() => {
  mockPayload = { userId: 'u1', sandboxId: 'sbx' };
});

describe('buildSandboxUpstreamHeaders', () => {
  test('preserves provider-owned ingress headers without knowing their names', async () => {
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: '', serviceKey: null, providerHeaders: {
      'X-Daytona-Skip-Preview-Warning': 'true',
      'X-Daytona-Disable-CORS': 'true',
      'e2b-traffic-access-token': 'e2b-token',
    } });
    expect(h['X-Daytona-Skip-Preview-Warning']).toBe('true');
    expect(h['X-Daytona-Disable-CORS']).toBe('true');
    expect(h['e2b-traffic-access-token']).toBe('e2b-token');
  });

  test('sets Authorization from the service key', async () => {
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'svc-key' });
    expect(h['Authorization']).toBe('Bearer svc-key');
  });

  test('omits Authorization when there is no service key', async () => {
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: null });
    expect(h['Authorization']).toBeUndefined();
  });

  test('includes provider traffic credentials only when supplied by the adapter', async () => {
    const withTok = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'k', providerHeaders: { 'X-Daytona-Preview-Token': 'ptok' } });
    expect(withTok['X-Daytona-Preview-Token']).toBe('ptok');
    const without = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'k' });
    expect(without['X-Daytona-Preview-Token']).toBeUndefined();
  });

  test('signs X-Kortix-User-Context when user + service key + payload exist', async () => {
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'svc-key' });
    expect(h['X-Kortix-User-Context']).toBe('signed:svc-key:u1');
  });

  test('omits the signed context when the user has no resolvable payload', async () => {
    mockPayload = null;
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'svc-key' });
    expect(h['X-Kortix-User-Context']).toBeUndefined();
  });

  test('omits the signed context for anonymous (no user) or keyless requests', async () => {
    const noUser = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: '', serviceKey: 'svc-key' });
    expect(noUser['X-Kortix-User-Context']).toBeUndefined();
    const noKey = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: null });
    expect(noKey['X-Kortix-User-Context']).toBeUndefined();
  });
});
