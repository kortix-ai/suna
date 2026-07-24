// FIX-A: PlatinumProvider.createFromExternalId boots POST /v1/sandboxes by the
// EXACT pinned template id, classifies a DEFINITIVE 404 (GC'd pin) as
// SandboxTemplateNotFoundError (so the boot path can name-fallback), and leaves a
// transient 5xx as a normal error (surface/retry, never a silent name-boot).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

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
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');
setTestEnv('PLATINUM_API_URL', 'https://api.platinum.dev');
setTestEnv('PLATINUM_API_KEY', 'pt_test_key');
setTestEnv('PLATINUM_TEMPLATE', 'tpl_default');

let calls: Array<{ path: string; method: string; body: Record<string, unknown> | undefined }> = [];
let sandboxesError: Error | null = null;

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJson: async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, method: String(init.method ?? 'GET'), body });
    if (path.startsWith('/v1/sandboxes?')) {
      if (sandboxesError) throw sandboxesError;
      return { id: 'sbx_new', state: 'running' };
    }
    if (path.includes('/expose')) return { url: 'https://sbx.test/agent', port: 8000, public: true };
    return {};
  },
}));
mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

const { PlatinumProvider } = await import('./platinum');
const { SandboxTemplateNotFoundError } = await import('./index');

const baseOpts = { accountId: 'a', userId: 'u', name: 'box', envVars: { KORTIX_SANDBOX_TOKEN: 'tok' } };

beforeEach(() => {
  calls = [];
  sandboxesError = null;
});

describe('FIX-A createFromExternalId', () => {
  test('boots POST /v1/sandboxes with the EXACT pinned template id (not the default)', async () => {
    const p = new PlatinumProvider();
    const res = await p.createFromExternalId('tpl_pinned_exact', { ...baseOpts });
    expect(res.externalId).toBe('sbx_new');
    const createCall = calls.find((c) => c.path.startsWith('/v1/sandboxes?') && c.method === 'POST');
    expect(createCall?.body?.template).toBe('tpl_pinned_exact');
  });

  test("a 404 (GC'd pin) throws SandboxTemplateNotFoundError so the boot path can name-fallback", async () => {
    sandboxesError = new Error('platinum POST /v1/sandboxes?wait_for_state=running -> 404 {"error":"template not found"}');
    const p = new PlatinumProvider();
    await expect(p.createFromExternalId('tpl_gone', { ...baseOpts })).rejects.toBeInstanceOf(
      SandboxTemplateNotFoundError,
    );
  });

  test('a transient 5xx is NOT a not-found (surface/retry, never a silent name-boot)', async () => {
    sandboxesError = new Error('platinum POST /v1/sandboxes?wait_for_state=running -> 503 {"error":"unavailable"}');
    const p = new PlatinumProvider();
    let caught: unknown;
    await p.createFromExternalId('tpl_x', { ...baseOpts }).catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SandboxTemplateNotFoundError);
    expect((caught as Error).message).toContain('503');
  });

  test('an empty id is rejected before any provider call', async () => {
    const p = new PlatinumProvider();
    await expect(p.createFromExternalId('   ', { ...baseOpts })).rejects.toThrow(/without a template id/);
    expect(calls).toHaveLength(0);
  });
});
