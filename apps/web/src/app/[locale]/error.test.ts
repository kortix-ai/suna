import { expect, test } from 'bun:test';

// "Sandbox still loading" is a transient INFO state, never an error. If it ever
// reaches this global boundary it must render NOTHING — no logo, no card, no
// message — and silently soft-reset until the runtime URL pins and the real page
// renders in place. The only trace is a console.debug. This reverses the earlier
// "push all handling to SandboxLoadingBoundary" stance, which proved insufficient
// because the throw reaches this boundary from outside the session subtree.
test('global boundary renders NOTHING for a transient runtime-not-ready state', async () => {
  const source = await Bun.file(import.meta.dir + '/error.tsx').text();
  expect(source).toContain('isRuntimeNotReadyError');
  // Recognized → soft-reset via Next's reset(), and render nothing.
  expect(source).toContain('reset()');
  expect(source).toContain('return null;');
  // Logged as info (console.debug), never surfaced or Sentry-reported as an error.
  expect(source).toContain('console.debug');
  // No visible UI whatsoever for the transient case.
  expect(source).not.toContain('aria-label="Loading session"');
  expect(source).not.toContain('Starting your session');
});

// The silent retry used to run forever. A runtime that never comes up left a
// blank window — a dead end on desktop, which has no browser Back or reload
// button. After the budget, the error card and its Try again take over.
test('the silent retry stops when its budget is spent', async () => {
  const source = await Bun.file(import.meta.dir + '/error.tsx').text();
  expect(source).toContain("from '@/lib/runtime-not-ready-budget'");
  expect(source).toContain('recordRuntimeNotReady(');
  expect(source).toContain('isRuntimeNotReadyExhausted(');
  // The blank branch is gated on the budget, not on the error type alone.
  expect(source).toContain('if (runtimeNotReady && !retryExhausted)');
  expect(source).not.toMatch(/if \(runtimeNotReady\) \{\s*\/\/ Render NOTHING/);
});

test('a genuine crash still shows the recoverable error card', async () => {
  const source = await Bun.file(import.meta.dir + '/error.tsx').text();
  expect(source).toContain('autoAppErrorJsxTextSomethingWentWrong493afd7e');
  expect(source).toContain('window.location.reload()');
});
