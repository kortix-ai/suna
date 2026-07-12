import { expect, test } from 'bun:test';

// Locks the SDK-level gate for the transient `RuntimeNotReadyError` cluster
// (Kortix Frontend prod): `[opencode-sdk] Server URL not ready — sandbox is
// still loading`. `app/error.tsx` handles the global route-segment render
// case, but the throw also reaches Sentry via `<ClientErrorBoundary>`,
// `route-error`/`system-fault`, the network branch of `error-handler`, and
// unhandled promise rejections. Sentry's `ignoreErrors` list is the one gate
// that covers ALL capture paths (it is checked before an event is sent), so
// the runtime-not-ready markers MUST live here too.

test('sentry.client.config ignores the transient runtime-not-ready markers', async () => {
  const source = await Bun.file(`${import.meta.dir}/../../sentry.client.config.ts`).text();
  expect(source).toContain('ignoreErrors');
  // The three marker strings that cover every variant of the throw
  // (RuntimeNotReadyError, the plain Error in env.ts/pty.ts, and any
  // re-wrapped unhandled-rejection preserving the wording).
  expect(source).toContain("'Server URL not ready'");
  expect(source).toContain("'sandbox is still loading'");
  expect(source).toContain("'opencode not ready'");
  // The beforeSend hook must still delegate to the noise filter (which also
  // classifies runtime-not-ready via shouldIgnoreSentryNoiseEvent).
  expect(source).toContain('shouldIgnoreSentryNoiseEvent');
});
