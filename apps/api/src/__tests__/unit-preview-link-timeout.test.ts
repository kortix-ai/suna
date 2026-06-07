/**
 * Regression test for the Better Stack incident
 *   ApiError — Request timed out after 30s:
 *     /projects/:id/sessions/:sid/ensure-opencode
 *   (error id ff961d2053e66c7c318276031e6c779dc6a6ce20d9b1e800a86771125fa590b3)
 *
 * Root cause: `resolvePreviewLink()` (sandbox-proxy/backend.ts) calls into the
 * provider control plane (Daytona SDK `get()` + `getPreviewLink()`), which take
 * no AbortSignal. On a cache miss with a slow/hung provider it hung with no
 * upper bound — past the frontend's 30s request timeout. `ensure-opencode`
 * resolves the endpoint via this path *before* its own bounded fetch, so it was
 * the most visible victim.
 *
 * The fix bounds the provider round-trip with a timeout race, and makes
 * `sandboxOpencodeEndpoint()` degrade a resolution failure to `null` (→ the
 * route returns a fast, retryable `unreachable` instead of hanging / 500ing).
 *
 * These tests pin both behaviours: a hung provider must reject/return quickly
 * rather than wait indefinitely. The timeout is driven short via env so the
 * test is deterministic and fast.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Drive the bound down to 50ms so a "hung" provider trips it in milliseconds.
process.env.PREVIEW_LINK_RESOLVE_TIMEOUT_MS = '50';

const SANDBOX_ID = 'sbx-ensure-opencode';

// A provider whose resolvePreviewLink never settles — models a slow/hung
// Daytona control plane (the SDK call that took no AbortSignal).
const hungProvider = {
  resolvePreviewLink: () => new Promise<never>(() => {}),
};

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          // loadSandbox: one row with a service key + daytona provider.
          limit: async () => [
            {
              sandboxId: SANDBOX_ID,
              externalId: SANDBOX_ID,
              projectId: 'proj',
              accountId: 'acct',
              provider: 'daytona',
              status: 'active',
              baseUrl: '',
              config: { serviceKey: 'svc-key' },
            },
          ],
        }),
      }),
    }),
  },
}));

mock.module('../platform/providers', () => ({
  getProvider: () => hungProvider,
}));

mock.module('../shared/daytona', () => ({ getDaytona: () => ({}) }));
mock.module('../shared/preview-ownership', () => ({
  resolvePreviewUserContext: async () => null,
}));
mock.module('../shared/kortix-user-context', () => ({
  KORTIX_USER_CONTEXT_HEADER: 'X-Kortix-User-Context',
  encodeKortixUserContext: () => 'signed',
}));

const { resolvePreviewLink, invalidateSandbox } = await import(
  '../sandbox-proxy/backend'
);
const { sandboxOpencodeEndpoint } = await import('../projects/opencode-mapping');

beforeEach(() => {
  // Clear any cached link/key so each call re-hits the (hung) provider.
  invalidateSandbox(SANDBOX_ID);
});

describe('resolvePreviewLink provider timeout (ensure-opencode 30s hang)', () => {
  test('rejects well under the client 30s timeout when the provider hangs', async () => {
    const started = Date.now();
    await expect(resolvePreviewLink(SANDBOX_ID, 8000)).rejects.toThrow(
      /timed out/i,
    );
    const elapsed = Date.now() - started;
    // Must be bounded by the (test) timeout, not hang indefinitely.
    expect(elapsed).toBeLessThan(5_000);
  });

  test('sandboxOpencodeEndpoint degrades to null (→ retryable unreachable) on a hung provider', async () => {
    const started = Date.now();
    const ep = await sandboxOpencodeEndpoint(SANDBOX_ID, 'user-1');
    const elapsed = Date.now() - started;
    expect(ep).toBeNull();
    expect(elapsed).toBeLessThan(5_000);
  });
});
