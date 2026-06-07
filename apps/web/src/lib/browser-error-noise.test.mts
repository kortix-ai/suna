import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExtensionSource,
  isFrozenPromiseInteropNoise,
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

test('does not suppress real application errors', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'TypeError: Cannot read properties of undefined (reading id)',
      filename: 'https://app.kortix.com/_next/static/chunk.js',
    }),
    false,
  )
})

test('detects the frozen-native-Promise interop signature (V8 wording)', () => {
  assert.equal(
    isFrozenPromiseInteropNoise(
      "Cannot assign to read only property 'then' of object '#<Promise>'",
    ),
    true,
  )
})

test('detects the frozen-native-Promise interop signature for catch/finally', () => {
  assert.equal(
    isFrozenPromiseInteropNoise(
      "Cannot assign to read only property 'catch' of object '#<Promise>'",
    ),
    true,
  )
  assert.equal(
    isFrozenPromiseInteropNoise(
      "Cannot assign to read only property 'finally' of object '#<Promise>'",
    ),
    true,
  )
})

test('detects the frozen-Promise interop signature across engine wordings', () => {
  // Firefox phrasing
  assert.equal(isFrozenPromiseInteropNoise('"then" is read-only'), true)
  // Safari/JSC phrasing
  assert.equal(
    isFrozenPromiseInteropNoise(
      "Attempted to assign to readonly property 'then'.",
    ),
    true,
  )
})

test('does not treat unrelated read-only-property errors as Promise interop noise', () => {
  assert.equal(
    isFrozenPromiseInteropNoise(
      "Cannot assign to read only property 'id' of object '#<Object>'",
    ),
    false,
  )
  assert.equal(isFrozenPromiseInteropNoise('"id" is read-only'), false)
})

test('suppresses the frozen-Promise interop TypeError as browser runtime noise', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        "TypeError: Cannot assign to read only property 'then' of object '#<Promise>'",
      filename: 'https://app.kortix.com/_next/static/chunks/14129-deadbeef.js',
    }),
    true,
  )
})

test('suppresses the frozen-Promise interop TypeError in Sentry events', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://app.kortix.com/projects/abc' },
      exception: {
        values: [
          {
            value:
              "Cannot assign to read only property 'then' of object '#<Promise>'",
            stacktrace: {
              frames: [
                {
                  filename:
                    'app:///_next/static/chunks/14129-864d9f9be69080bf.js',
                },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})
