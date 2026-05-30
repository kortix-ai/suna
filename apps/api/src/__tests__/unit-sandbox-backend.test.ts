/**
 * Unit tests for backend.buildSandboxUpstreamHeaders — the single header
 * builder shared by the HTTP forwarder and the WebSocket upstream resolver.
 * Both edges must produce an identical auth/identity header set, so this is
 * the contract that keeps them from drifting apart again.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

let mockPayload: { userId: string; sandboxId: string } | null = null;

mock.module('../shared/db', () => ({ db: {} }));
mock.module('../shared/daytona', () => ({ getDaytona: () => ({}) }));
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
  test('always sets the Daytona preview-warning + CORS-disable flags', async () => {
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: '', serviceKey: null, previewToken: null });
    expect(h['X-Daytona-Skip-Preview-Warning']).toBe('true');
    expect(h['X-Daytona-Disable-CORS']).toBe('true');
  });

  test('sets Authorization from the service key', async () => {
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'svc-key', previewToken: null });
    expect(h['Authorization']).toBe('Bearer svc-key');
  });

  test('omits Authorization when there is no service key', async () => {
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: null, previewToken: null });
    expect(h['Authorization']).toBeUndefined();
  });

  test('includes the preview token when present, omits it when null', async () => {
    const withTok = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'k', previewToken: 'ptok' });
    expect(withTok['X-Daytona-Preview-Token']).toBe('ptok');
    const without = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'k', previewToken: null });
    expect(without['X-Daytona-Preview-Token']).toBeUndefined();
  });

  test('signs X-Kortix-User-Context when user + service key + payload exist', async () => {
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'svc-key', previewToken: null });
    expect(h['X-Kortix-User-Context']).toBe('signed:svc-key:u1');
  });

  test('omits the signed context when the user has no resolvable payload', async () => {
    mockPayload = null;
    const h = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: 'svc-key', previewToken: null });
    expect(h['X-Kortix-User-Context']).toBeUndefined();
  });

  test('omits the signed context for anonymous (no user) or keyless requests', async () => {
    const noUser = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: '', serviceKey: 'svc-key', previewToken: null });
    expect(noUser['X-Kortix-User-Context']).toBeUndefined();
    const noKey = await buildSandboxUpstreamHeaders({ sandboxId: 'sbx', userId: 'u1', serviceKey: null, previewToken: null });
    expect(noKey['X-Kortix-User-Context']).toBeUndefined();
  });
});
