// A session box opens its agent port inside the create round trip (Platinum's
// inline `expose`). The standalone POST /:id/expose runs only when the create
// answer carries no URL for that port: a wait timeout, an Idempotency-Key
// replay, or a Platinum without inline expose.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
mock.module('../sandbox-ownership', () => ({ sandboxOwnershipMarker: async () => 'v2-owner-a' }));

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.com');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('PLATINUM_API_URL', 'https://api.platinum.dev');
setTestEnv('PLATINUM_API_KEY', 'pt_test_key');
setTestEnv('PLATINUM_TEMPLATE', 'tpl_default');

let calls: Array<{ path: string; method: string; body: Record<string, unknown> | undefined }> = [];
let createAnswer: Record<string, unknown> = { id: 'sbx_new', state: 'running' };

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJsonResponse: async () => {
    throw new Error('unexpected Platinum materialization request');
  },
  platinumJson: async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, method: String(init.method ?? 'GET'), body });
    if (path.startsWith('/v1/sandboxes?')) return createAnswer;
    if (path.includes('/expose')) return { url: 'https://8000-sbx.test/?t=standalone', port: 8000, public: false };
    return {};
  },
}));
mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

const { PlatinumProvider } = await import('./platinum');

const baseOpts = { accountId: 'a', userId: 'u', name: 'box', envVars: { KORTIX_TOKEN: 'tok' } };
const createCall = () => calls.find((c) => c.path.startsWith('/v1/sandboxes?') && c.method === 'POST');
const exposeCalls = () => calls.filter((c) => c.path.endsWith('/expose'));

beforeEach(() => {
  calls = [];
  createAnswer = { id: 'sbx_new', state: 'running' };
});

describe('Platinum inline expose on create', () => {
  test('the create body asks for the agent port, private, with the preview token lifetime', async () => {
    await new PlatinumProvider().createFromExternalId('tpl_x', { ...baseOpts });
    expect(createCall()?.body?.expose).toEqual([{ port: 8000, public: false, ttl_seconds: 86_400 }]);
  });

  test('an answer that opened the port makes no POST /expose', async () => {
    createAnswer = {
      id: 'sbx_new',
      state: 'running',
      via: 'cold-boot',
      exposed: [{ port: 8000, url: 'https://8000-sbx.test/?t=inline', public: false, token: 'inline' }],
    };
    const res = await new PlatinumProvider().createFromExternalId('tpl_x', { ...baseOpts });
    expect(res.externalId).toBe('sbx_new');
    expect(exposeCalls()).toHaveLength(0);
  });

  test('an answer without `exposed` (replay, wait timeout, older Platinum) falls back to POST /expose', async () => {
    await new PlatinumProvider().createFromExternalId('tpl_x', { ...baseOpts });
    expect(exposeCalls()).toHaveLength(1);
    expect(exposeCalls()[0]?.body).toEqual({ port: 8000, public: false, ttl_seconds: 86_400 });
  });

  test('an answer that opened a different port still exposes the agent port', async () => {
    createAnswer = {
      id: 'sbx_new',
      state: 'running',
      exposed: [{ port: 8080, url: 'https://8080-sbx.test/?t=other', public: false }],
    };
    await new PlatinumProvider().createFromExternalId('tpl_x', { ...baseOpts });
    expect(exposeCalls()).toHaveLength(1);
  });
});
