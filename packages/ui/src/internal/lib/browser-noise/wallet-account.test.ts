import { test, expect } from 'bun:test';
import { shouldIgnoreSentryBrowserNoise, shouldIgnoreBrowserRuntimeNoise } from '../browser-error-noise';

const message = 'Object captured as promise rejection with keys: code, message';
const rejected = { code: 4001, message: 'wallet must has at least one account' };

function event(value: unknown = rejected, frames: Array<{ filename: string }> = []) {
  return { extra: { __serialized__: value }, exception: { values: [{ type: 'UnhandledRejection', value: message, stacktrace: { frames } }] } };
}

test('drops the captured frameless wallet missing-account rejection', () => {
  expect(shouldIgnoreSentryBrowserNoise(event())).toBe(true);
});

test('keeps first-party and bundle frames actionable', () => {
  for (const filename of ['app:///apps/web/src/app/page.tsx', 'https://kortix.com/_next/static/chunks/app.js']) {
    expect(shouldIgnoreSentryBrowserNoise(event(rejected, [{ filename }]))).toBe(false);
  }
});

test('does not generalize to other codes, messages, or payloads', () => {
  for (const value of [null, {}, { ...rejected, code: '4001' }, { ...rejected, code: 4900 }, { ...rejected, message: 'Request rejected' }, { ...rejected, data: {} }]) {
    expect(shouldIgnoreSentryBrowserNoise(event(value))).toBe(false);
  }
  expect(shouldIgnoreSentryBrowserNoise({ message, exception: { values: [{ value: message }] } })).toBe(false);
  expect(shouldIgnoreBrowserRuntimeNoise({ reason: rejected })).toBe(false);
});
