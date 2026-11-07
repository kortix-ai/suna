import { expect, test } from 'bun:test';
import { shouldIgnoreSentryBrowserNoise } from '../browser-error-noise';

// KRTX-4430: the four frames of the observed capture, oldest first.
const bridge = 'app:///dragOutMainWorldBridge.8fa8d734.js?1794035030389?r=1794035030405';
const frames = [
  { filename: bridge, function: '?' },
  { filename: bridge, function: '?' },
  { filename: bridge, function: 'newRequire' },
  { filename: bridge, function: 'Object.fIhds' },
];
const message = "Cannot read properties of undefined (reading 'connect')";

function event(stack: Array<{ filename: string; function: string }>) {
  return {
    exception: {
      values: [{ value: message, mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false }, stacktrace: { frames: stack } }],
    },
  };
}

test('filters the injected drag-out bridge script through Sentry', () => {
  expect(shouldIgnoreSentryBrowserNoise(event(frames))).toBe(true);
  expect(shouldIgnoreSentryBrowserNoise(event([{ filename: 'app:///dragOutMainWorldBridge.0a1b2c3d.js', function: '?' }]))).toBe(true);
});

test('keeps reporting the same TypeError from first-party and near-match sources', () => {
  for (const filename of [
    'app:///_next/static/chunks/0a1b2c3d.js',
    'apps/web/src/app/page.tsx',
    'app:///_next/static/chunks/dragOutMainWorldBridge.8fa8d734.js',
    'https://kortix.com/dragOutMainWorldBridge.8fa8d734.js',
    'app:///dragOutMainWorldBridge.js',
    'app:///dragOutMainWorldBridge.8fa8d734.jsx',
  ]) {
    expect(shouldIgnoreSentryBrowserNoise(event([{ filename, function: 'connect' }]))).toBe(false);
  }
});
