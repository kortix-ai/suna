import { describe, expect, test } from 'bun:test';
import {
  isKnownBrowserNoiseMessage,
  shouldIgnoreBrowserRuntimeNoise,
  shouldIgnoreSentryNoiseEvent,
} from './browser-error-noise';

// Regression: a tech-detection scanner bot (UA "TechDetect/1.0 HeadlessChrome")
// hit https://kortix.com/ and triggered an unhandled rejection from injected code
// that tried to reassign `.then` on a native Promise. Kortix never assigns
// Promise#then, so this is pure third-party/bot noise and must not page us.
// Better Stack pattern df06367391b6cd5b562c5da7c5a028963cc3d9edede59dcc379f596955ada9ae
const PROMISE_THEN_READONLY_MESSAGE =
  "Cannot assign to read only property 'then' of object '#<Promise>'";

describe('isKnownBrowserNoiseMessage — read-only Promise#then', () => {
  test('matches the V8 "Cannot assign to read only property \'then\'" message', () => {
    expect(isKnownBrowserNoiseMessage(PROMISE_THEN_READONLY_MESSAGE)).toBe(true);
  });

  test('does not match an unrelated genuine error', () => {
    expect(
      isKnownBrowserNoiseMessage('Cannot read properties of undefined (reading then)'),
    ).toBe(false);
  });
});

describe('shouldIgnoreSentryNoiseEvent — read-only Promise#then', () => {
  test('drops the bot-triggered unhandled rejection event', () => {
    const event = {
      environment: 'prod',
      request: { url: 'https://kortix.com/' },
      exception: {
        values: [
          {
            value: PROMISE_THEN_READONLY_MESSAGE,
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/14129-864d9f9be69080bf.js' },
              ],
            },
          },
        ],
      },
    };
    expect(shouldIgnoreSentryNoiseEvent(event)).toBe(true);
  });

  test('keeps a real first-party TypeError', () => {
    const event = {
      environment: 'prod',
      request: { url: 'https://kortix.com/projects' },
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'id')",
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/app/projects-abc123.js' },
              ],
            },
          },
        ],
      },
    };
    expect(shouldIgnoreSentryNoiseEvent(event)).toBe(false);
  });
});

describe('shouldIgnoreBrowserRuntimeNoise — read-only Promise#then', () => {
  test('drops an onunhandledrejection reason with the read-only Promise#then message', () => {
    expect(
      shouldIgnoreBrowserRuntimeNoise({
        reason: new TypeError(PROMISE_THEN_READONLY_MESSAGE),
      }),
    ).toBe(true);
  });
});
