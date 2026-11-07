import { expect, test } from 'bun:test';
import { shouldIgnoreBrowserRuntimeNoise, shouldIgnoreSentryBrowserNoise } from '../browser-error-noise';

// KRTX-4387: an injected `tracking_script.js` asks Closure's jsloader for the
// gapi client; the CSP blocks apis.google.com and the loader throws.
const message =
  'Jsloader error (code #0): Error while loading script https://apis.google.com/js/client.js?onload=_gapiProviderCallback_1';
const frames = [
  { filename: 'app:///tracking_script.js', function: 'e.onerror' },
  { filename: 'app:///tracking_script.js', function: 'new vc' },
];

function event(value = message, stack = frames) {
  return { exception: { values: [{ type: 'CustomError', value, stacktrace: { frames: stack } }] } };
}

test('filters the injected tracking_script.js gapi load failure through Sentry', () => {
  expect(shouldIgnoreSentryBrowserNoise(event())).toBe(true);
  expect(shouldIgnoreSentryBrowserNoise(event(message.replace('#0', '#1')))).toBe(true);
});

test('preserves first-party frames, other scripts and other messages', () => {
  for (const filename of ['apps/web/src/app/page.tsx', 'packages/ui/src/session/index.ts']) {
    expect(shouldIgnoreSentryBrowserNoise(event(message, [...frames, { filename, function: 'render' }]))).toBe(false);
  }
  expect(shouldIgnoreSentryBrowserNoise(event(message, [{ filename: 'app:///_next/static/chunks/a.js', function: 'r' }]))).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event(message, []))).toBe(false);
  expect(
    shouldIgnoreSentryBrowserNoise(event('Jsloader error (code #0): Error while loading script https://kortix.com/a.js')),
  ).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event("Cannot read properties of undefined (reading 'x')"))).toBe(false);
  expect(shouldIgnoreBrowserRuntimeNoise({ message })).toBe(false);
});
