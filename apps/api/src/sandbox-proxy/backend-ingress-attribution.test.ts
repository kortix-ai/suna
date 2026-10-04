// KRTX-471: a proxied request whose cached ingress link is stale pays a
// provider round-trip (Platinum's POST /expose, Daytona's preview link)
// inline before it dials. The request-context split counted none of it, so a
// latency spike here read as unexplained API time — the ~5 s give-ups this
// issue investigated carried only the failed daemon dials in `upstream_ms`.
// These tests pin the attribution: the provider's `resolveIngress` time lands
// in `upstream_ms` and in the diagnostic fields the completion log line reads.
//
// The heavier ../config + ../shared/db deps are mocked to inert stubs, and
// `getProvider` is replaced with one whose resolveIngress stalls — same shape
// as backend.test.ts, whose process-global mock.module is why this lives in
// its own file.
import { describe, expect, mock, test } from 'bun:test';
import * as realProviders from '../platform/providers';
import * as realKortixUserContext from '../shared/kortix-user-context';
import * as realPreviewOwnership from '../shared/preview-ownership';

mock.module('../lib/config', () => ({ config: {} }));
mock.module('../shared/db', () => ({ db: {} }));
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  resolvePreviewUserContext: async () => null,
}));
mock.module('../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
  encodeKortixUserContext: () => '',
}));

const INGRESS_DELAY_MS = 300;

mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    async resolveIngress() {
      await new Promise((resolve) => setTimeout(resolve, INGRESS_DELAY_MS));
      return { url: 'http://sandbox.local', headers: {}, effectivePort: 8000 };
    },
    routeIngress: () => ({ effectivePort: 8000 }),
  }),
}));

const { resolveSandboxIngress } = await import('./backend');
const { getDiagnosticFields, runWithContext } = await import('../lib/request-context');
const { upstreamMsSoFar } = await import('../middleware/upstream-timing');

const RECORD = {
  sandboxId: 'sbx-1',
  externalId: 'ext-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  agentName: null,
  provider: 'platinum',
  status: 'active',
  baseUrl: '',
  serviceKey: 'svc-key',
};

describe('resolveSandboxIngress upstream attribution', () => {
  test('a slow provider resolveIngress lands in upstream_ms and the diagnostic fields', async () => {
    let measured = 0;
    let logged = 0;
    await runWithContext('GET', '/v1/p/ext-1/8000/file/raw', async () => {
      await resolveSandboxIngress(RECORD, { port: 8000, transport: 'http' });
      measured = upstreamMsSoFar();
      logged = Number(getDiagnosticFields().upstream_ms ?? 0);
    });
    expect(measured).toBeGreaterThanOrEqual(INGRESS_DELAY_MS);
    expect(logged).toBeGreaterThanOrEqual(INGRESS_DELAY_MS);
  });

  test('outside a request scope the attribution is a no-op, never a throw', async () => {
    // A different externalId: the first test's key is now cached, and this
    // must exercise the resolver itself, not the cache hit.
    await resolveSandboxIngress(
      { ...RECORD, externalId: 'ext-2' },
      { port: 8000, transport: 'http' },
    );
  });
});
