import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExpectedBillingGateMessage,
  isExtensionSource,
  isInjectedAppSource,
  isKnownBrowserNoiseMessage,
  isRuntimeNotReadyNoiseMessage,
  isStaleWebpackRuntimeCallNoise,
  isStorageDisabledWebViewNoiseMessage,
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

// Reproduces Better Stack error 1426e718... (38 occurrences) and b04a2106...
// (6 occurrences), Kortix Frontend (prod), application_id 2346967: a browser-
// native image load failure raised through window.onerror. The app already
// degrades gracefully via onError handlers, so the exact message is noise.
test('suppresses the "Failed to load image" browser noise via runtime guard', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Error: Failed to load image',
      filename: 'app:///_next/static/chunks/main.js',
    }),
    true,
  )
})

test('suppresses the bare "Failed to load image" Sentry exception', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://app.kortix.com/projects' },
      exception: {
        values: [
          {
            value: 'Failed to load image',
            stacktrace: {
              frames: [{ filename: 'app:///_next/static/chunks/main.js' }],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('does NOT suppress a real application error that merely mentions images', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://app.kortix.com/projects' },
      exception: {
        values: [
          {
            value: 'TypeError: Cannot read properties of undefined (reading src)',
            stacktrace: { frames: [{ filename: 'app:///_next/static/chunks/app.js' }] },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress an actionable pptx image-processing failure', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://app.kortix.com/projects' },
      exception: {
        values: [
          {
            value: 'Failed to load image for colour change processing',
            stacktrace: {
              frames: [{ filename: 'app:///_next/static/chunks/pptx-viewer.js' }],
            },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress a same-worded server exception without a browser frame', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: { values: [{ value: 'Failed to load image' }] },
    }),
    false,
  )
})

// Reproduces Better Stack error 140195488...4f7255 (4 occurrences) + sibling
// 50c1919a...0bf1cd (2 occurrences), Kortix Frontend (prod), application_id
// 2346967: an `ApiError` with message "Out of credits. Top up to continue."
// (the exact body the API billing gate emits for an `insufficient_credits`
// HTTP 402 — apps/api/src/billing/services/billing-gate.ts:assertBillingActive).
//
// `apps/web/src/lib/error-handler.tsx:handleApiError` already routes a
// structured 402 `insufficient_credits` to a top-up toast and intentionally
// only reports 5xx/network/timeout to Sentry. But the SDK's `ApiError` can
// reach Sentry through capture paths that bypass that guard —
// `route-error`/`system-fault`/`app/error`/`<ClientErrorBoundary>`'s
// unconditional `Sentry.captureException`, and the Sentry SDK's own
// `onunhandledrejection` auto-capture. An expected, user-facing billing state
// must never page Better Stack; drop it at the telemetry gate regardless of
// which capture path delivered it. The exact messages are the only strings the
// billing gate emits for a 402 — real `ApiError`s ("Internal server error",
// "HTTP 500: …", etc.) keep reporting.
const BILLING_GATE_EXPECTED_EVENTS = [
  // The assigned error + sibling share this exact message.
  'Out of credits. Top up to continue.',
  // An unhandled-rejection wrapper preserving the message.
  'Unhandled promise rejection: ApiError: Out of credits. Top up to continue.',
  // The other two billing-gate 402 reasons — same expected business state,
  // same leak paths, same fix (prevents the next noise pattern).
  'No credit account found. Complete account setup first.',
  'Subscribe to activate your seat. $20/teammate per month includes wallet credits for compute and LLM usage.',
]

test('classifies every billing-gate 402 message as an expected business state', () => {
  for (const message of BILLING_GATE_EXPECTED_EVENTS) {
    assert.equal(
      isExpectedBillingGateMessage(message),
      true,
      `expected ${message} to be classified as an expected billing-gate message`,
    )
  }
})

test('suppresses a billing-gate 402 Sentry event regardless of capture path', () => {
  for (const value of BILLING_GATE_EXPECTED_EVENTS) {
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

test('suppresses a billing-gate 402 unhandled rejection from the browser', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Unhandled promise rejection: Out of credits. Top up to continue.',
    }),
    true,
  )
})

test('does NOT suppress a real ApiError / internal server error', () => {
  for (const value of [
    'Internal server error',
    'HTTP 500: Internal Server Error',
    'TypeError: Cannot read properties of undefined (reading id)',
  ]) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      false,
      `expected real error "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message: value }),
      false,
      `expected real error "${value}" to keep reporting`,
    )
  }
})

test('does NOT suppress an unrelated message that merely mentions "credits"', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [{ value: 'Failed to deduct credits for the run' }],
      },
    }),
    false,
  )
})

test('does NOT suppress a longer real error containing the billing-gate phrase', () => {
  for (const value of [
    'Failed to retry run: Out of credits. Top up to continue.',
    'Out of credits. Top up to continue. Database reconciliation failed',
    'ApiError: Out of credits. Top up to continue. while starting sandbox',
    'Unhandled promise rejection: Something else: Out of credits. Top up to continue.',
  ]) {
    assert.equal(
      isExpectedBillingGateMessage(value),
      false,
      `expected longer message "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      false,
      `expected longer Sentry event "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message: value }),
      false,
      `expected longer runtime error "${value}" to keep reporting`,
    )
  }
})

test('suppresses storage-disabled WebView null.getItem TypeErrors (V8 + JSC)', () => {
  for (const value of [
    "TypeError: Cannot read properties of null (reading 'getItem')",
    "Cannot read properties of null (reading 'setItem')",
    "Cannot read properties of null (reading 'removeItem')",
    "TypeError: Cannot read property 'getItem' of null",
    "Cannot read property 'setItem' of null",
  ]) {
    assert.equal(
      isStorageDisabledWebViewNoiseMessage(value),
      true,
      `expected "${value}" to be classified as storage-disabled WebView noise`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message: value }),
      true,
      `expected runtime error "${value}" to be suppressed`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      true,
      `expected Sentry event "${value}" to be suppressed`,
    )
  }
})

test('does NOT suppress a real null-access error on a non-storage method', () => {
  assert.equal(
    isStorageDisabledWebViewNoiseMessage("Cannot read properties of null (reading 'map')"),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: { values: [{ value: "Cannot read properties of null (reading 'map')" }] },
    }),
    false,
  )
})

// Reproduces Better Stack error 83e0c2af...189c3b17 (Kortix Frontend prod,
// application_id 2346967) + siblings 5d02255f…, e77f06d4…, 1cb3009d… — all
// `TypeError: Cannot read properties of undefined (reading 'call')`, count 1,
// 0 identified users, last_seen 2026-07-12 08:44 UTC. The raw stack's throwing
// frame (last frame, Sentry oldest-first ordering) is the Next.js webpack
// runtime chunk `webpack-<hash>.js` function `c` (= `__webpack_require__`), and
// the webpack runtime chunk carries a *different* Vercel `?dpl=` deployment id
// than the app chunks in the same stack — the stale-deploy-chunk signature:
// a long-lived tab holds app chunks/module ids from one deploy while the
// runtime chunk is served from another, so `__webpack_modules__[moduleId]` is
// `undefined` and `.call(...)` throws. One-off, self-heals on reload; not an
// app defect. Suppressed ONLY when the throwing frame is the runtime chunk, so
// a real app `.call` TypeError (which throws inside an app chunk, not the
// runtime) still reports.
const WEBPACK_RUNTIME_FRAME = {
  filename:
    'app:///_next/static/chunks/webpack-35676c5ce2292e1c.js?dpl=dpl_CTqmc8S7CG7w9gkCs2ySzURsbhxm',
  function: 'c',
}
const APP_CHUNK_FRAME = {
  filename:
    'app:///_next/static/chunks/app/(app)/projects/[id]/not-found-c7f03e853940d826.js?dpl=dpl_GnR22QKUwZLPkRykUCM8KBxZmy8o',
  function: '81761',
}

test('suppresses the stale-deploy webpack-runtime call TypeError (assigned pattern)', () => {
  // The exact frame chain from the raw 83e0c2af… event: webpack `c` recurses
  // through app chunks, and the throwing frame (last) is the runtime `c`.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/projects' },
      exception: {
        values: [
          {
            value: "Cannot read properties of undefined (reading 'call')",
            stacktrace: {
              frames: [
                WEBPACK_RUNTIME_FRAME,
                APP_CHUNK_FRAME,
                WEBPACK_RUNTIME_FRAME,
                {
                  filename:
                    'app:///_next/static/chunks/65820-89cc54263b2034da.js?dpl=dpl_GnR22QKUwZLPkRykUCM8KBxZmy8o',
                  function: '65820',
                },
                WEBPACK_RUNTIME_FRAME,
                {
                  filename:
                    'app:///_next/static/chunks/27594-5ca3ed0a68bbd353.js?dpl=dpl_GnR22QKUwZLPkRykUCM8KBxZmy8o',
                  function: '36735',
                },
                WEBPACK_RUNTIME_FRAME,
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses a minimal stale-webpack-runtime call event', () => {
  assert.equal(
    isStaleWebpackRuntimeCallNoise({
      message: "Cannot read properties of undefined (reading 'call')",
      frames: [APP_CHUNK_FRAME, WEBPACK_RUNTIME_FRAME],
    }),
    true,
  )
})

test('does NOT suppress the same message when the throwing frame is an app chunk', () => {
  // A real app TypeError calling `.call(...)` on an `undefined` value throws
  // inside the app chunk, not the runtime — keep reporting it.
  assert.equal(
    isStaleWebpackRuntimeCallNoise({
      message: "Cannot read properties of undefined (reading 'call')",
      frames: [WEBPACK_RUNTIME_FRAME, APP_CHUNK_FRAME],
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: "Cannot read properties of undefined (reading 'call')",
            stacktrace: { frames: [WEBPACK_RUNTIME_FRAME, APP_CHUNK_FRAME] },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress the webpack-call message when there are no frames', () => {
  // Can't confirm the runtime scope — keep reporting rather than guess.
  assert.equal(
    isStaleWebpackRuntimeCallNoise({
      message: "Cannot read properties of undefined (reading 'call')",
      frames: [],
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [{ value: "Cannot read properties of undefined (reading 'call')" }],
      },
    }),
    false,
  )
})

test('does NOT suppress a same-shaped message reading a different property', () => {
  // `reading id` / `reading src` are the existing real-app TypeError fixtures;
  // the exact-message match must not catch them.
  for (const value of [
    'Cannot read properties of undefined (reading id)',
    'Cannot read properties of undefined (reading src)',
    'TypeError: Cannot read properties of undefined (reading call)',
  ]) {
    assert.equal(
      isStaleWebpackRuntimeCallNoise({
        message: value,
        frames: [WEBPACK_RUNTIME_FRAME],
      }),
      false,
      `expected "${value}" to keep reporting`,
    )
  }
})
