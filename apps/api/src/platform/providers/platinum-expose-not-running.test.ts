// Regression for Better Stack error ea98adefe8696ddbe341f3280fe699c230f8f0fb31221e7a5740a91f485085f0:
// `platinum POST /v1/sandboxes/.../expose -> 409 {"code":"sandbox_not_running"}`.
//
// Platinum auto-stops idle microVMs natively; while a box is stopped, expose
// 409s. That EXPECTED state must reach app.onError as the typed
// PlatinumSandboxNotRunningError (→ controlled 503 + Retry-After, no Sentry),
// NOT as a generic Error (→ 500 + captureException). This proves the provider's
// expose entry points (resolveIngress, and resolveEndpoint which delegates to
// it) propagate the typed error untouched — i.e. they neither swallow it nor
// rewrap it into a generic Error — so the global onError classification
// actually fires on the real expose path.
import { expect, mock, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'platinum';
process.env.PLATINUM_API_KEY = 'pt_test_key';
process.env.PLATINUM_API_URL = 'https://api.platinum.dev';
process.env.PLATINUM_TEMPLATE = 'tpl_test';
process.env.KORTIX_URL ??= 'https://api.example.com';
process.env.DATABASE_URL ??= 'postgres://x';

// Stand in for the real typed error without importing the module-under-test's
// dependency: the provider only rethrows whatever platinumJson throws, so an
// instance of this class propagating through proves the contract.
class PlatinumSandboxNotRunningError extends Error {
  constructor(message = 'sandbox is not running') {
    super(message);
    this.name = 'PlatinumSandboxNotRunningError';
  }
}

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  isPlatinumSandboxNotRunningError: (e: unknown) => e instanceof PlatinumSandboxNotRunningError,
  PlatinumSandboxNotRunningError,
  platinumJson: async (path: string) => {
    // Expose on a stopped box → the typed error (mirrors real Platinum 409).
    if (path.includes('/expose')) {
      throw new PlatinumSandboxNotRunningError(
        `platinum POST ${path} -> 409 {"error":"sandbox not running","code":"sandbox_not_running"}`,
      );
    }
    return {};
  },
}));

mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

async function makeProvider() {
  const { PlatinumProvider } = await import('./platinum');
  return new PlatinumProvider();
}

test('resolveIngress propagates PlatinumSandboxNotRunningError (not a generic Error)', async () => {
  const p = await makeProvider();
  const err = await p
    .resolveIngress('sbx_stopped', { port: 8000, transport: 'http' })
    .catch((e) => e);
  expect(err).toBeInstanceOf(PlatinumSandboxNotRunningError);
  expect((err as Error).name).toBe('PlatinumSandboxNotRunningError');
  expect((err as Error).message).toContain('sandbox_not_running');
});

test('resolveEndpoint propagates PlatinumSandboxNotRunningError (delegates to resolveIngress)', async () => {
  const p = await makeProvider();
  const err = await p.resolveEndpoint('sbx_stopped').catch((e) => e);
  expect(err).toBeInstanceOf(PlatinumSandboxNotRunningError);
  expect((err as Error).name).toBe('PlatinumSandboxNotRunningError');
  expect((err as Error).message).toContain('sandbox_not_running');
});
