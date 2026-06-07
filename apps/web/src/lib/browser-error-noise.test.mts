import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExtensionSource,
  isFrozenIntrinsicsNoiseMessage,
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

// Wallet/SES browser extensions freeze Promise.prototype before our JS runs;
// React's bundled RSC Flight runtime then throws assigning Chunk.prototype.then.
// The throwing frame is our own _next chunk, so the extension-source filter
// misses it — match on the message instead. See vercel/next.js#78823.
test('detects the frozen-Promise (SES/wallet extension) RSC then-assignment noise', () => {
  assert.equal(
    isFrozenIntrinsicsNoiseMessage(
      "Cannot assign to read only property 'then' of object '#<Promise>'",
    ),
    true,
  )
})

test('classifies the frozen-intrinsics then-assignment as known browser noise', () => {
  assert.equal(
    isKnownBrowserNoiseMessage(
      "TypeError: Cannot assign to read only property 'then' of object '#<Promise>'",
    ),
    true,
  )
})

test('suppresses the frozen-Promise error coming from our own _next chunk', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://www.kortix.com/projects' },
      exception: {
        values: [
          {
            value: "Cannot assign to read only property 'then' of object '#<Promise>'",
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/14129-864d9f9be69080bf.js' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('also matches the WebKit "Attempted to assign to readonly property" wording', () => {
  assert.equal(
    isFrozenIntrinsicsNoiseMessage(
      "TypeError: Attempted to assign to readonly property 'then'",
    ),
    true,
  )
})

// Guard against over-suppression: a read-only-assignment error that does NOT
// target a frozen intrinsic `then` is a genuine app bug and must still report.
test('does not suppress a real read-only-property error on app state', () => {
  assert.equal(
    isFrozenIntrinsicsNoiseMessage(
      "Cannot assign to read only property 'count' of object '#<Object>'",
    ),
    false,
  )
  assert.equal(
    isKnownBrowserNoiseMessage(
      "Cannot assign to read only property 'count' of object '#<Object>'",
    ),
    false,
  )
})
