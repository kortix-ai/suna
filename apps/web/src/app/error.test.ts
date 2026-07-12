import { expect, test } from 'bun:test';

// The global boundary must degrade a TRANSIENT runtime-not-ready throw (which
// fires on every session switch before the runtime URL pins, and self-heals in a
// second or two) to a silent auto-retry — never the hard "Something went wrong"
// crash. This reverses the previous expectation, which pushed all handling to
// SandboxLoadingBoundary; that proved insufficient because the throw reaches this
// boundary from callers OUTSIDE the session subtree (and from stale bundles).
test('global error boundary auto-retries transient runtime-not-ready errors', async () => {
  const source = await Bun.file(import.meta.dir + '/error.tsx').text();
  // It must recognize the transient class and soft-reset via Next's `reset()`.
  expect(source).toContain('isRuntimeNotReadyError');
  expect(source).toContain('reset()');
  // It must NOT hard-reload the page for the transient case (jarring loop) — the
  // full reload stays reserved for the manual "Try again" on a genuine crash.
  expect(source).not.toContain('Starting your session');
});

test('a genuine crash still shows the recoverable error card', async () => {
  const source = await Bun.file(import.meta.dir + '/error.tsx').text();
  expect(source).toContain('autoAppErrorJsxTextSomethingWentWrong493afd7e');
  expect(source).toContain('window.location.reload()');
});
