import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// The connector data plane must stay pinned to the injected session identity
// (KRTX-1705): a session only ever invokes `kortix connectors` (template
// runtime fingerprint), so a human's in-sandbox `hosts use` selection must
// not redirect it at the selected host — while a cwd link still does
// (KRTX-2529: the link's stored credentials are what reach a non-session
// project). The pin now lives in `resolveProjectAuth`'s `envPin` branch,
// which the gateway face passes; these tests guard the pin itself — the env
// auth outranks the stored auth for both gateway entry points, whatever the
// config file says.

const clients: string[] = [];
const sdks: string[] = [];
const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // The env pin only arms when an injected token host exists; the project id
  // comes from the env chain the pin protects.
  process.env.KORTIX_TOKEN = 'kortix_pat_session';
  process.env.KORTIX_API_URL = 'https://session.example/v1';
  process.env.KORTIX_PROJECT_ID = 'proj_session';
  // Point config storage at a path that does not exist so no real link or
  // auth leaks in.
  process.env.KORTIX_CONFIG_FILE = '/nonexistent/kortix-pin-config.json';
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Spread the real module: `mock.module` replaces it WHOLESALE, and the import
// graph of gateway.ts → command-helpers.ts pulls other exports of this file
// (loadAuthForHost) — a hand-rolled mock broke them at link time in batch runs.
import * as realAuth from '../api/auth.ts';
mock.module('../api/auth.ts', () => ({
  ...realAuth,
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

const { connectorClient, connectorProjectContext } = await import(
  '../connector-gateway/gateway.ts'
);

describe('connector gateway identity pin (KRTX-1705)', () => {
  test('connectorClient builds its SDK from the injected session token', async () => {
    sdks.length = 0;
    await connectorClient();
    expect(sdks).toEqual(['kortix_pat_session']);
  });

  test('connectorProjectContext pairs the session token with the session project', async () => {
    clients.length = 0;
    const ctx = await connectorProjectContext();
    expect(ctx.projectId).toBe('proj_session');
    expect(clients).toEqual(['kortix_pat_session']);
  });
});
