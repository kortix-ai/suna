import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExtensionSource,
  isFrozenPromiseNoise,
  isKnownBrowserNoiseMessage,
  shouldIgnoreBrowserRuntimeNoise,
  shouldIgnoreSentryBrowserNoise,
} from './browser-error-noise.ts'

test('matches the Safari runtime.sendMessage tab-not-found noise', () => {
  assert.equal(
    isKnownBrowserNoiseMessage('Invalid call to runtime.sendMessage(). Tab not found.'),
    true,
  )
})

test('detects Safari extension sources', () => {
  assert.equal(
    isExtensionSource('safari-web-extension://com.example.extension/content.js'),
    true,
  )
})

test('suppresses runtime messaging noise from browser events', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Unhandled promise rejection: Invalid call to runtime.sendMessage(). Tab not found.',
    }),
    true,
  )
})

test('suppresses extension-backed Sentry events', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://app.kortix.com/auth' },
      exception: {
        values: [
          {
            value: 'Invalid call to runtime.sendMessage(). Tab not found.',
            stacktrace: {
              frames: [
                { filename: 'safari-web-extension://com.example.extension/background.js' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('matches the frozen-Promise webpack-runtime noise (V8)', () => {
  assert.equal(
    isFrozenPromiseNoise(
      "Cannot assign to read only property 'then' of object '#<Promise>'",
    ),
    true,
  )
})

test('matches the frozen-Promise noise reported by Firefox', () => {
  assert.equal(isFrozenPromiseNoise('TypeError: "then" is read-only'), true)
})

test('suppresses the frozen-Promise Sentry event from an injected scanner', () => {
  // Real prod event: a TechDetect/1.0 HeadlessChrome scanner froze the native
  // Promise, so webpack's runtime threw while loading chunks on the homepage.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/' },
      exception: {
        values: [
          {
            value:
              "Cannot assign to read only property 'then' of object '#<Promise>'",
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/webpack-f184a7555004bb8b.js' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('does not suppress real application errors', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'TypeError: Cannot read properties of undefined (reading id)',
      filename: 'https://app.kortix.com/_next/static/chunk.js',
    }),
    false,
  )
})

test('does not suppress an app error that merely mentions then', () => {
  // A genuine bug ("foo.then is not a function") must still be reported — only
  // the exact engine-emitted read-only-Promise signature is treated as noise.
  assert.equal(isFrozenPromiseNoise('foo.then is not a function'), false)
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://app.kortix.com/dashboard' },
      exception: {
        values: [
          {
            value: 'TypeError: result.then is not a function',
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/dashboard.js' },
              ],
            },
          },
        ],
      },
    }),
    false,
  )
})
