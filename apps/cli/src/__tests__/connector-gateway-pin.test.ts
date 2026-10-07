import { describe, expect, mock, test } from 'bun:test';

// The connector data plane must stay pinned to the injected session identity
// (KRTX-1705): a session only ever invokes `kortix connectors` / `kortix
// connectors mcp` (template runtime fingerprint), so a human's in-sandbox
// `hosts use` selection must not redirect it at the selected host. These
// tests guard the pin itself — the env auth outranks the stored auth for
// both gateway entry points, whatever the config file says.

const clients: string[] = [];
const sdks: string[] = [];

mock.module('../api/auth.ts', () => ({
  loadAuth: () => ({
    api_base: 'https://own.example/v1',
    token: 'kortix_pat_stored',
    user_id: 'user_own',
    user_email: 'owner@own.example',
    account_id: 'acct_own',
    logged_in_at: '2026-01-01T00:00:00.000Z',
  }),
  loadEnvAuth: () => ({
    api_base: 'https://session.example/v1',
    token: 'kortix_pat_session',
    user_id: 'user_session',
    user_email: 'agent@example.test',
    account_id: 'acct_session',
    logged_in_at: '2026-01-01T00:00:00.000Z',
  }),
}));
mock.module('../api/client.ts', () => ({
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
  clientFromAuth: (auth: { token: string }) => {
    clients.push(auth.token);
    return { token: auth.token };
  },
}));
mock.module('../api/sdk.ts', () => ({
  kortixFromAuth: (auth: { token: string }) => {
    sdks.push(auth.token);
    return { project: () => ({ connectors: { token: auth.token } }) };
  },
}));
mock.module('../project-link.ts', () => ({ resolveProjectId: () => 'proj_session' }));

const { connectorClient, connectorProjectContext } = await import(
  '../connector-gateway/gateway.ts'
);

describe('connector gateway identity pin (KRTX-1705)', () => {
  test('connectorClient builds its SDK from the injected session token', () => {
    sdks.length = 0;
    connectorClient();
    expect(sdks).toEqual(['kortix_pat_session']);
  });

  test('connectorProjectContext pairs the session token with the session project', () => {
    clients.length = 0;
    const ctx = connectorProjectContext();
    expect(ctx.projectId).toBe('proj_session');
    expect(clients).toEqual(['kortix_pat_session']);
  });
});
