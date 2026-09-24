import type { TunnelPermissionRequest } from '@/hooks/tunnel/use-tunnel';
import { afterEach, describe, expect, test } from 'bun:test';
import { useTunnelStore } from './tunnel-store';

const request = {
  requestId: 'request-test-dismissed',
  tunnelId: 'tunnel-test',
  capability: 'shell',
  requestedScope: {},
} as TunnelPermissionRequest;

afterEach(() => useTunnelStore.getState().clearPendingRequests());

describe('tunnel permission request dismissal', () => {
  test('a dismissed request cannot reopen from a repeated SSE event', () => {
    useTunnelStore.getState().addPendingRequest(request);
    expect(useTunnelStore.getState().pendingRequests).toHaveLength(1);

    useTunnelStore.getState().removePendingRequest(request.requestId);
    useTunnelStore.getState().addPendingRequest(request);

    expect(useTunnelStore.getState().pendingRequests).toHaveLength(0);
  });
});
