import { expect, test } from 'bun:test';
import { shouldIgnoreBrowserRuntimeNoise, shouldIgnoreSentryBrowserNoise } from '../browser-error-noise';

// KRTX-4423: a crawler's automation driver evaluates a string in the page; the
// CSP blocks it and the injected `<anonymous>` script rejects with EvalError.
const message =
  "Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://www.googletagmanager.com\".\n";
const frames = [
  { filename: '<anonymous>', function: 'next' },
  { filename: '<anonymous>', function: 'predicate' },
  { filename: '<anonymous>', function: 'eval' },
];

function event(value = message, stack = frames) {
  return {
    exception: {
      values: [
        {
          type: 'EvalError',
          value,
          mechanism: { type: 'auto.browser.global_handlers.onunhandledrejection', handled: false },
          stacktrace: { frames: stack },
        },
      ],
    },
  };
}

test('filters a CSP-blocked eval raised only by injected <anonymous> code', () => {
  expect(shouldIgnoreSentryBrowserNoise(event())).toBe(true);
});

test('preserves an eval from our bundles, a blob worker, first-party source, vendors, no stack and other messages', () => {
  for (const filename of [
    'app:///_next/static/chunks/a.js',
    // KRTX-3580: a bundled decoder's blob worker called `new Function`.
    'blob:https://kortix.com/00000000-0000-4000-8000-000000000000',
    'apps/web/src/app/page.tsx',
    'packages/ui/src/session/index.ts',
    'https://www.googletagmanager.com/gtm.js',
  ]) {
    expect(shouldIgnoreSentryBrowserNoise(event(message, [...frames, { filename, function: 'run' }]))).toBe(false);
  }
  expect(shouldIgnoreSentryBrowserNoise(event(message, []))).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event('Evaluating a string as JavaScript is not allowed'))).toBe(false);
  expect(shouldIgnoreBrowserRuntimeNoise({ message })).toBe(false);
});
