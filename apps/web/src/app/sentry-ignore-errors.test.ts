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

test('sentry.client.config anchors expected billing-gate 402 markers', async () => {
  const source = await Bun.file(`${import.meta.dir}/../../sentry.client.config.ts`).text();
  expect(source).toContain(
    '/^(?:Unhandled promise rejection: )?(?:ApiError: )?Out of credits\\. Top up to continue\\.$/',
  );
  // Guard against reintroducing a bare string entry: Sentry treats string
  // ignoreErrors values as contains-matches, which would hide longer real
  // errors that merely mention the billing-gate phrase.
  expect(source).not.toContain("'Out of credits. Top up to continue.'");
});

test('sentry.client.config anchors the expected no-compaction-model marker', async () => {
  // Reproduces Better Stack error 9f72dd9a2cb49a81aa57be27e9b3cb2f1ef06a8ebf59ede6900267febd3f7ded
  // (Kortix Frontend prod): the SDK's `useSummarizeOpenCodeSession` mutation
  // throws a sentinel `NoCompactionModelError` when no model is configured
  // anywhere — an expected, user-facing config state the host already toasts.
  // It leaks to Sentry as an unhandled promise rejection
  // (`void loadingToast(...)` re-throws after the toast → `onunhandledrejection`).
  // Sentry's `ignoreErrors` list is checked before an event is sent (covers
  // every capture path, including frameless onerror), so the anchored marker
  // MUST live here. Anchored so a longer real mutation failure that merely
  // mentions the wording keeps reporting.
  const source = await Bun.file(`${import.meta.dir}/../../sentry.client.config.ts`).text();
  expect(source).toContain(
    '/^(?:Unhandled promise rejection: )?(?:Error: )?No model available for compaction\\. Please configure a model in settings\\.$/',
  );
  // Guard against reintroducing a bare string entry: Sentry treats string
  // ignoreErrors values as contains-matches, which would hide longer real
  // errors that merely mention the compaction wording.
  expect(source).not.toContain("'No model available for compaction.'");
});

test('sentry.client.config ignores storage-disabled WebView null-access TypeErrors', async () => {
  const source = await Bun.file(`${import.meta.dir}/../../sentry.client.config.ts`).text();
  // Storage-disabled in-app WebViews resolve localStorage/sessionStorage to
  // null; direct .getItem/.setItem/.removeItem then throw. These are
  // browser-environment failures, not app defects, so the SDK drops them.
  expect(source).toContain("Cannot read properties of null (reading 'getItem')");
  expect(source).toContain("Cannot read properties of null (reading 'setItem')");
  expect(source).toContain("Cannot read properties of null (reading 'removeItem')");
  // JSC variant (older Safari/iOS WebView).
  expect(source).toContain("Cannot read property 'getItem' of null");
});

test('sentry.client.config drops the old-WebKit lookbehind parse failure', async () => {
  // Reproduces Better Stack error 6d987ab4...34e7ed (Kortix Frontend prod):
  // Safari/iOS < 16.4 cannot parse lookbehind assertions and throws
  // `SyntaxError: Invalid regular expression: invalid group specifier name`
  // at chunk parse time. The lookbehind lives in bundled third-party deps
  // (`mdast-util-gfm-autolink-literal`, `@pierre/diffs`), the wording is
  // WebKit-specific, and only old Safari/iOS visitors hit it. Sentry's
  // `ignoreErrors` list is checked before an event is sent (covers every
  // capture path, including frameless onerror), so the marker MUST live here.
  const source = await Bun.file(`${import.meta.dir}/../../sentry.client.config.ts`).text();
  expect(source).toContain("'invalid group specifier name'");
});
