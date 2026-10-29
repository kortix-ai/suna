import { expect, test } from 'bun:test';
import { shouldIgnoreBrowserRuntimeNoise, shouldIgnoreSentryBrowserNoise } from '../browser-error-noise';

const message = 'Talisman extension has not been configured yet. Please continue with onboarding.';
const frames = [
  { filename: 'app:///_next/static/immutable/chunks/synthetic.js', function: 'r' },
  { filename: 'app:///page.js', function: '?' },
  { filename: 'app:///page.js', function: 'ne.handleResponse' },
];

function event(value = message, stack = frames) {
  return { exception: { values: [{ value, stacktrace: { frames: stack } }] } };
}

test('filters the observed Talisman onboarding rejection through Sentry', () => {
  expect(shouldIgnoreSentryBrowserNoise(event())).toBe(true);
});

test('preserves first-party throws and unrelated page.js failures', () => {
  for (const filename of ['apps/web/src/app/page.tsx', 'packages/ui/src/session/index.ts']) {
    expect(shouldIgnoreSentryBrowserNoise(event(message, [...frames, { filename, function: 'render' }]))).toBe(false);
  }
  expect(shouldIgnoreSentryBrowserNoise(event('Please continue with onboarding.'))).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event(message, [frames[0]]))).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event(message, []))).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event(message, [{ filename: 'app:///page.js', function: 'render' }]))).toBe(false);
  expect(shouldIgnoreBrowserRuntimeNoise({ message })).toBe(false);
});
