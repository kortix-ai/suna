import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExtensionSource,
  isInjectedAppSource,
  isKnownBrowserNoiseMessage,
  isRuntimeNotReadyNoiseMessage,
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

test('matches third-party Promise.then tampering noise', () => {
  assert.equal(
    isKnownBrowserNoiseMessage(
      "Cannot assign to read only property 'then' of object '#<Promise>'",
    ),
    true,
  )
})

// Reproduces Better Stack error 8bc2dce8...0384f8 (Kortix Frontend prod):
// a recoverable React #418 hydration mismatch raised via onerror on a pt-PT
// user's browser. Chrome's auto-translate (offered because the page renders in
// English) rewrites text nodes before hydration, which React reports as a
// server/client mismatch. It fired on the marketing 404 (`/pt`) and on the
// post-login `/projects` landing — neither contains `/auth`, so the old
// route-scoped guard let it through. It must now be suppressed everywhere.
const REACT_418 =
  'Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]= ' +
  'for the full message or use the non-minified dev environment for full errors ' +
  'and additional helpful warnings.'

test('suppresses the React #418 hydration noise on the marketing site (/pt)', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/pt' },
      exception: {
        values: [
          {
            value: REACT_418,
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/414c69f9-e0c657363ae93f0c.js' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the React #418 hydration noise on the post-login /projects landing', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/projects?auth_event=login&auth_method=google' },
      exception: {
        values: [
          {
            value: REACT_418,
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/414c69f9-e0c657363ae93f0c.js' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('still suppresses the generic "Hydration failed because the server rendered" message', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/' },
      exception: {
        values: [
          {
            value:
              'Hydration failed because the server rendered HTML didn\'t match the client.',
            stacktrace: { frames: [{ filename: 'app:///_next/static/chunks/main.js' }] },
          },
        ],
      },
    }),
    true,
  )
})

test('does NOT suppress a genuine, non-recoverable app hydration error', () => {
  // React #425 ("Text content does not match server-rendered HTML") is the
  // deterministic, app-caused hydration class and is not in the noise list, so
  // it must still reach error tracking even on a non-/auth route.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/projects' },
      exception: {
        values: [
          {
            value: 'Minified React error #425; visit https://react.dev/errors/425 for the full message',
            stacktrace: { frames: [{ filename: 'app:///_next/static/chunks/app.js' }] },
          },
        ],
      },
    }),
    false,
  )
})

test('suppresses the Better Stack Promise.then incident event', () => {
  // Reproduces error c4085f6b...256290 (Kortix Frontend prod): an
  // onunhandledrejection from a scanner bot monkey-patching native Promise.then
  // on the marketing homepage. The de-minified frame points at our own chunk,
  // so this must be matched by message, not by source.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/' },
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

test('flags the injected embed widget source as third-party noise', () => {
  assert.equal(isInjectedAppSource('app:///embed/embed.js'), true)
  assert.equal(isInjectedAppSource('app:///_next/static/chunks/main.js'), false)
})

// Reproduces the Kortix Frontend (prod) RuntimeNotReadyError cluster (patterns
// 1a9acfd0…, 4c20d52d…, 7e2697b4…, a58cd1cb…, …). `getClient()` throws
// `RuntimeNotReadyError: [opencode-sdk] Server URL not ready — sandbox is
// still loading` for the ~1s window before a session's runtime URL pins — an
// expected, self-healing state on every session switch/provisioning. The
// render-path UI handling lives in `app/error.tsx` + `SandboxLoadingBoundary`,
// but the throw can also reach Sentry through `<ClientErrorBoundary>`,
// `route-error`/`system-fault`, the network branch of `error-handler`, and
// unhandled promise rejections. The filter below is the telemetry-side
// backstop that drops it regardless of capture path.
const RUNTIME_NOT_READY_EVENTS = [
  // The canonical SDK throw (RuntimeNotReadyError).
  'RuntimeNotReadyError: [opencode-sdk] Server URL not ready — sandbox is still loading',
  // The bare message (env.ts path / re-wrapped).
  '[opencode-sdk] Server URL not ready — sandbox is still loading',
  // The pty guard variant.
  '[kortix-pty] Server URL not ready — sandbox is still loading',
  // An unhandled-rejection wrapper preserving the message.
  'Unhandled promise rejection: Server URL not ready — sandbox is still loading',
  // The "opencode not ready" sibling wording used by env/pty guards.
  'opencode not ready — sandbox is still starting',
]

test('classifies every runtime-not-ready variant as transient noise', () => {
  for (const message of RUNTIME_NOT_READY_EVENTS) {
    assert.equal(
      isRuntimeNotReadyNoiseMessage(message),
      true,
      `expected ${message} to be classified as runtime-not-ready noise`,
    )
  }
})

test('suppresses a runtime-not-ready Sentry event regardless of capture path', () => {
  for (const value of RUNTIME_NOT_READY_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://app.kortix.com/projects/p/sessions/s' },
        exception: {
          values: [
            {
              value,
              stacktrace: {
                frames: [{ filename: 'app:///_next/static/chunks/sdk.js' }],
              },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses a runtime-not-ready unhandled rejection from the browser', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        'Unhandled promise rejection: [opencode-sdk] Server URL not ready — sandbox is still loading',
    }),
    true,
  )
})

test('does NOT suppress a genuine runtime/server error that is not the transient not-ready state', () => {
  assert.equal(
    isRuntimeNotReadyNoiseMessage('Error: the OpenCode daemon crashed mid-turn (exit code 1)'),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [{ value: 'TypeError: Cannot read properties of undefined (reading id)' }],
      },
    }),
    false,
  )
})
