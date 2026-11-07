import { expect, test } from 'bun:test';
import { shouldIgnoreBrowserRuntimeNoise, shouldIgnoreSentryBrowserNoise } from '../browser-error-noise';

const message = 'NotUnlocked: Unlock Shield to use a DApp.';
// The frames of the observed event (KRTX-4433), throw site last.
const frames = [
  { filename: 'app:///background.js', function: '?' },
  { filename: 'app:///background.js', function: 'yW' },
  { filename: 'app:///background.js', function: 'Il' },
];

function event(value = message, stack = frames) {
  return { exception: { values: [{ type: 'Error', value, stacktrace: { frames: stack } }] } };
}

test('filters the locked Shield wallet rejection from its background.js', () => {
  expect(shouldIgnoreSentryBrowserNoise(event())).toBe(true);
});

test('keeps first-party frames, other messages and other sources reportable', () => {
  for (const filename of ['app:///apps/web/src/app/page.tsx', 'packages/ui/src/session/index.ts']) {
    expect(shouldIgnoreSentryBrowserNoise(event(message, [...frames, { filename, function: 'render' }]))).toBe(false);
  }
  expect(shouldIgnoreSentryBrowserNoise(event('NotUnlocked: Unlock to continue.'))).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event(message, []))).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event(message, [{ filename: 'app:///_next/static/chunks/a.js', function: 'Il' }]))).toBe(false);
  expect(shouldIgnoreBrowserRuntimeNoise({ message })).toBe(false);
});
