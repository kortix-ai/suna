import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isAndroidWebViewNativeBridgePostMessageNoise,
  isClientRequestTimeoutMessage,
  isEmptyMessageUnresolvedBrowserChunkNoise,
  isExpectedBillingGateMessage,
  isExtensionSource,
  isInjectedAppSource,
  isInpageWalletStreamNoise,
  isKnownBrowserNoiseMessage,
  isOldBrowserSyntaxParseError,
  isOldWebkitRegexNoiseMessage,
  isPaperShaderNullContextNoise,
  isRuntimeNotReadyNoiseMessage,
  isStaleWebpackRuntimeCallNoise,
  isStorageDisabledWebViewNoiseMessage,
  isStorageSecurityErrorNoise,
  isTronLinkProxyNoise,
  isUnresolvableStackOverflowNoise,
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

// Reproduces Better Stack error patterns
// 09b9cf65ca7c954bf031fc6fb570a96c4e47ce4ed5f0b9ed8b10c688fc2f27de and
// ac75f0d8a9b73ae88b68f02693d72ecc5137b5e1d2c14a430de5190a42cdfd64
// (Kortix Frontend prod, application_id 2346967), both
// `SecurityError: Failed to read the 'localStorage' property from 'window':
// Access is denied for this document.`, 1 occurrence each, 0 identified users,
// last 2026-07-12 17:54:04 UTC. Storage-blocked browser contexts (Safari
// private mode, sandboxed/cross-origin iframe, partitioned storage, some in-app
// WebViews) reject the `window.localStorage`/`sessionStorage` accessor READ
// itself with this `SecurityError`; a direct `window.localStorage` call site
// that bypasses the managed-storage try/catch throws it uncaught → Sentry →
// Better Stack. Browser-environment noise, not an app defect. The matcher
// drops it UNLESS the stack carries a resolved first-party `apps/web/src/…`
// frame (our own code is the direct-access culprit → actionable to fix).
const STORAGE_SECURITY_ERROR_EVENTS = [
  // The exact raw production message (localStorage).
  "SecurityError: Failed to read the 'localStorage' property from 'window': Access is denied for this document.",
  // Bare message (no `SecurityError:` prefix).
  "Failed to read the 'localStorage' property from 'window': Access is denied for this document.",
  // Unhandled-rejection leak path preserving the message.
  "Unhandled promise rejection: SecurityError: Failed to read the 'localStorage' property from 'window': Access is denied for this document.",
  // The sessionStorage sibling variant (same root class, same instant).
  "SecurityError: Failed to read the 'sessionStorage' property from 'window': Access is denied for this document.",
  "Failed to read the 'sessionStorage' property from 'window': Access is denied for this document.",
  "Unhandled promise rejection: Failed to read the 'sessionStorage' property from 'window': Access is denied for this document.",
]

// A raw minified chunk frame (no resolved `apps/web/src/…` source) — the
// browser-environment noise shape: storage blocked, no traceable first-party
// call site. Should be suppressed.
const CHUNK_FRAME_STORAGE = 'app:///_next/static/chunks/21544-ac9e889808bbe0af.js'

test('classifies every storage-blocked SecurityError variant as noise (no first-party frame)', () => {
  for (const message of STORAGE_SECURITY_ERROR_EVENTS) {
    assert.equal(
      isStorageSecurityErrorNoise({ message }),
      true,
      `expected "${message}" to be classified as storage SecurityError noise`,
    )
    assert.equal(
      isStorageSecurityErrorNoise({ message, frames: [{ filename: CHUNK_FRAME_STORAGE }] }),
      true,
      `expected "${message}" from a minified chunk frame to be noise`,
    )
    assert.equal(
      isStorageSecurityErrorNoise({ message, filename: CHUNK_FRAME_STORAGE }),
      true,
      `expected "${message}" from a chunk filename to be noise`,
    )
  }
})

test('suppresses the storage SecurityError Sentry event via the beforeSend gate', () => {
  for (const value of STORAGE_SECURITY_ERROR_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://kortix.com/' },
        exception: {
          values: [
            {
              value,
              stacktrace: { frames: [{ filename: CHUNK_FRAME_STORAGE }] },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses a frameless storage SecurityError Sentry event (no first-party frame to preserve)', () => {
  // A frameless capture carries no resolved first-party frame, so the negative
  // guard does not apply — the message is the browser's own access-control
  // throw (never an app-logic error), so it is safe to drop.
  for (const value of STORAGE_SECURITY_ERROR_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      true,
      `expected frameless Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses the storage SecurityError unhandled rejection via the runtime (window.onerror) gate', () => {
  for (const message of STORAGE_SECURITY_ERROR_EVENTS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message }),
      true,
      `expected runtime gate to suppress "${message}"`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message, filename: CHUNK_FRAME_STORAGE }),
      true,
      `expected runtime gate to suppress "${message}" from a chunk filename`,
    )
  }
})

test('does NOT suppress a storage SecurityError whose stack resolves to a first-party app frame', () => {
  // A de-minified `apps/web/src/…` frame means our own code is reading
  // `window.localStorage` directly (bypassing managed-storage) — actionable,
  // so it must keep reporting so the call site can be fixed. This is the
  // negative guard that distinguishes actionable noise from the rest.
  const realAppFrames: Array<{ filename: unknown }> = [
    [{ filename: 'app:///apps/web/src/lib/storage/some-store.ts' }],
    [{ filename: 'apps/web/src/features/auth/use-auth.ts' }],
  ]
  for (const frames of realAppFrames) {
    for (const message of STORAGE_SECURITY_ERROR_EVENTS) {
      assert.equal(
        isStorageSecurityErrorNoise({ message, frames }),
        false,
        `expected first-party event "${message}" from ${JSON.stringify(frames)} to keep reporting`,
      )
      assert.equal(
        shouldIgnoreSentryBrowserNoise({
          exception: {
            values: [{ value: message, stacktrace: { frames } }],
          },
        }),
        false,
        `expected Sentry gate to keep reporting first-party "${message}" from ${JSON.stringify(frames)}`,
      )
    }
  }
  // And via the runtime gate: a first-party filename keeps reporting too.
  for (const message of STORAGE_SECURITY_ERROR_EVENTS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({
        message,
        filename: 'apps/web/src/lib/storage/some-store.ts',
      }),
      false,
      `expected runtime gate to keep reporting first-party "${message}"`,
    )
  }
})

test('does NOT suppress a storage SecurityError when only ONE of several frames is first-party', () => {
  // A mixed stack (chunk frame + one resolved first-party frame) still has a
  // traceable first-party call site — keep reporting it.
  assert.equal(
    isStorageSecurityErrorNoise({
      message: "SecurityError: Failed to read the 'localStorage' property from 'window': Access is denied for this document.",
      frames: [
        { filename: CHUNK_FRAME_STORAGE },
        { filename: 'app:///apps/web/src/lib/desktop.ts' },
      ],
    }),
    false,
  )
})

test('does NOT suppress a non-storage SecurityError with the same shape', () => {
  // A SecurityError on a DIFFERENT window property is not the storage-blocked
  // class — keep reporting it.
  for (const value of [
    "SecurityError: Failed to read the 'parent' property from 'Window': Access is denied for this document.",
    "Failed to read the 'document' property from 'window'",
    'Access is denied for this document.',
  ]) {
    assert.equal(
      isStorageSecurityErrorNoise({ message: value }),
      false,
      `expected non-storage message "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      false,
      `expected Sentry event "${value}" to keep reporting`,
    )
  }
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

// Reproduces Better Stack error b1db01e5c9dec8c62bf37ca994cbe304550a7699b8fcd04c8f5c01cc76fc9dc7
// (Kortix Frontend prod, application_id 2346967): a single
// `ApiError — Request timed out after 30s: /projects/<id>/sessions/<sid>/audit`
// at 2026-07-12 13:53 UTC. The SDK's `makeRequest` aborts a non-streaming fetch
// once its 30s budget elapses (`packages/sdk/src/core/http/api-client.ts`,
// `didTimeout` branch) and surfaces `ApiError(..., { code: 'TIMEOUT' })`. This
// is the frontend mirror of the API's request-deadline 503
// (`apps/api/src/middleware/request-deadline.ts`, de-noised from Sentry by
// kortix-ai/suna#4524): the API bounds every non-streaming request to a 25s
// server deadline (clean 503 + Retry-After), and react-query retries background
// polls — the session-audit route is polled every 5–15s from several session
// surfaces — so a 30s client abort is an EXPECTED, retryable degradation under
// momentary API saturation, not an actionable bug. The saturation signal stays
// in per-route metrics + the structured 503 warn log. `handleApiError` already
// drops `code === 'TIMEOUT'` from `captureException`; these checks are the
// telemetry-side backstop for leak paths (ClientErrorBoundary / route-error /
// app-error / onunhandledrejection).
const CLIENT_REQUEST_TIMEOUT_EVENTS = [
  // The exact assigned occurrence — endpoint varies per call, so match the
  // SDK's `Request timed out after <N>s: ` prefix, not the full URL.
  'Request timed out after 30s: /projects/24e99500-c925-481a-bc88-5b89dba4d965/sessions/88488045-8cd7-4c6b-ad0f-2b56a4c9cb25/audit',
  // The budget is configurable per call; the seconds value is not load-bearing.
  'Request timed out after 60s: /accounts',
  // The ApiError-class-prefixed wrapper.
  'ApiError: Request timed out after 30s: /projects/p/sessions/s/sandbox-health',
  // An unhandled-rejection leak path preserving the message.
  'Unhandled promise rejection: Request timed out after 30s: /projects/p/sessions/s/audit',
  'Unhandled promise rejection: ApiError: Request timed out after 30s: /change-requests',
]

test('classifies every client-side request-deadline timeout as expected noise', () => {
  for (const message of CLIENT_REQUEST_TIMEOUT_EVENTS) {
    assert.equal(
      isClientRequestTimeoutMessage(message),
      true,
      `expected ${message} to be classified as a client request timeout`,
    )
  }
})

test('suppresses a client-side request-timeout Sentry event regardless of capture path', () => {
  for (const value of CLIENT_REQUEST_TIMEOUT_EVENTS) {
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

test('suppresses a client-side request-timeout unhandled rejection from the browser', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        'Unhandled promise rejection: Request timed out after 30s: /projects/p/sessions/s/audit',
    }),
    true,
  )
})

test('does NOT suppress the API server-deadline 503 message (different wording)', () => {
  // The API's request-deadline 503 is `Request exceeded the 25s server processing
  // deadline` — a different, server-side wording that must keep reporting if it
  // ever reaches the frontend Sentry config (it is de-noised at the API source
  // by #4524, not here).
  for (const value of [
    'Request exceeded the 25s server processing deadline',
    'Request exceeded the 30s server processing deadline',
  ]) {
    assert.equal(
      isClientRequestTimeoutMessage(value),
      false,
      `expected server-deadline message "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({ exception: { values: [{ value }] } }),
      false,
      `expected server-deadline Sentry event "${value}" to keep reporting`,
    )
  }
})

test('does NOT suppress a generic third-party "request timed out" message', () => {
  // A third-party library's generic timeout wording must not be matched — only
  // the SDK's exact `Request timed out after <N>s: ` prefix is suppressed.
  for (const value of [
    'The request timed out',
    'Request timed out',
    'request timed out after 5000ms',
    'Network request timed out, please retry',
  ]) {
    assert.equal(
      isClientRequestTimeoutMessage(value),
      false,
      `expected generic message "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({ exception: { values: [{ value }] } }),
      false,
      `expected generic Sentry event "${value}" to keep reporting`,
    )
  }
})

test('does NOT suppress a real 5xx server ApiError', () => {
  for (const value of [
    'Internal server error',
    'HTTP 500: Internal Server Error',
    'Service maintenance in progress. Please try again later.',
  ]) {
    assert.equal(
      isClientRequestTimeoutMessage(value),
      false,
      `expected real server error "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({ exception: { values: [{ value }] } }),
      false,
      `expected real server error "${value}" to keep reporting`,
    )
  }
})

// Reproduces Better Stack error 6d987ab4...34e7ed (1 occurrence, 0 users),
// Kortix Frontend (prod), application_id 2346967: a Safari 15.6.1 visitor on
// the marketing homepage (`https://kortix.com/`) hit a chunk parse-time
// `SyntaxError: Invalid regular expression: invalid group specifier name`.
// Old WebKit (< 16.4) cannot parse lookbehind assertions — JSC reads `(?<` as
// a named-capture-group opener, sees the following `=` / `!`, and throws this
// message, failing the whole chunk. The lookbehind literals live in bundled
// THIRD-PARTY deps (`mdast-util-gfm-autolink-literal@2.0.1`'s GFM email
// autolink regex `/(?<=^|\s|\p{P}|\p{S})…/gu` and `@pierre/diffs`'s
// `SPLIT_WITH_NEWLINES = /(?<=\n)/`), the wording is WebKit-specific (V8/Node
// say "Invalid group"), and only very old Safari/iOS visitors hit it. The
// de-minified frame points at our own chunk, so it is matched by message, not
// by source.
const OLD_WEBKIT_REGEX_EVENTS = [
  // The exact raw event value from Better Stack (Safari 15.6.1, macOS 10.15.7).
  'Invalid regular expression: invalid group specifier name',
  // window.onerror can prefix the message with the exception type.
  'SyntaxError: Invalid regular expression: invalid group specifier name',
  // An unhandled-rejection wrapper preserving the message.
  'Unhandled promise rejection: Invalid regular expression: invalid group specifier name',
]

test('classifies every old-WebKit lookbehind parse variant as noise', () => {
  for (const message of OLD_WEBKIT_REGEX_EVENTS) {
    assert.equal(
      isOldWebkitRegexNoiseMessage(message),
      true,
      `expected ${message} to be classified as old-WebKit regex noise`,
    )
  }
})

test('suppresses an old-WebKit lookbehind Sentry event from the marketing site', () => {
  for (const value of OLD_WEBKIT_REGEX_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://kortix.com/' },
        exception: {
          values: [
            {
              value,
              stacktrace: {
                frames: [
                  { filename: 'app:///_next/static/chunks/76904-c52ab52c4900447c.js' },
                ],
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

test('suppresses an old-WebKit lookbehind unhandled rejection from the browser', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        'Unhandled promise rejection: Invalid regular expression: invalid group specifier name',
    }),
    true,
  )
})

test('does NOT suppress a real V8/Node regex error with different wording', () => {
  // Modern V8/Node say "Invalid group" / "Invalid regular expression: \(\?<=\)",
  // never "invalid group specifier name" — those keep reporting.
  assert.equal(isOldWebkitRegexNoiseMessage('Invalid regular expression: /(?!<=)/: Invalid group'), false)
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: { values: [{ value: 'TypeError: Cannot read properties of undefined (reading id)' }] },
    }),
    false,
  )
})

// Reproduces the old-browser minified-chunk `SyntaxError` parse-failure cluster
// (Kortix Frontend prod, application_id 2346967), all 1–2 occurrences each, 0
// users, from `app:///_next/static/chunks/…` minified bundles on old browsers
// / stripped-down WebViews. The browser cannot parse modern minified JS —
// incompatible, not an app defect. Covered Better Stack fingerprints:
//   Unexpected token '='        0015b43d…, 23ac8ed3…, 0665f05e…, 4bcd8a1a…,
//                               bb3aef66…, 277d3a4a…
//   Unexpected token '('        dfe7db0b…, 1aa71b82…, a75e4f55…, 7a61bbd1…,
//                               38e4f3da…
//   Unexpected token '{'        aff45748…, 40ed5a29…
//   Invalid or unexpected token c8f836d4…, 572a247e…
//   Cannot use import statement outside a module  17aeb077…
// The message prefixes are generic (a real `new Function('…')` / `eval('…')`
// eval bug throws the same wording), so the matcher requires BOTH the message
// prefix AND a minified-chunk frame (`_next/static/chunks/` or `?dpl=dpl_…`).
// Parse failures fire at raw chunk load time, before Sentry sourcemap
// resolution, so the frame filename stays as the raw chunk path — a genuine
// first-party eval bug de-minifies to `apps/web/src/…` and is never hidden.
const CHUNK_FRAME = 'app:///_next/static/chunks/76904-c52ab52c4900447c.js'

const OLD_BROWSER_SYNTAX_PARSE_EVENTS = [
  // `Unexpected token '='` family (V8/SpiderMonkey).
  "Unexpected token '='",
  "SyntaxError: Unexpected token '='",
  "Unhandled promise rejection: SyntaxError: Unexpected token '='",
  // `Unexpected token '('` family.
  "Unexpected token '('",
  "SyntaxError: Unexpected token '('",
  // `Unexpected token '{'` family.
  "Unexpected token '{'",
  "SyntaxError: Unexpected token '{'",
  // `Invalid or unexpected token` (V8).
  'Invalid or unexpected token',
  'SyntaxError: Invalid or unexpected token',
  'Unhandled promise rejection: Invalid or unexpected token',
  // `Cannot use import statement outside a module` (V8, ES-module chunk
  // loaded as a classic script by an old browser).
  'Cannot use import statement outside a module',
  'SyntaxError: Cannot use import statement outside a module',
  'Unhandled promise rejection: SyntaxError: Cannot use import statement outside a module',
]

test('classifies every old-browser minified-chunk SyntaxError variant as noise (with a chunk frame)', () => {
  for (const message of OLD_BROWSER_SYNTAX_PARSE_EVENTS) {
    assert.equal(
      isOldBrowserSyntaxParseError({ message, frames: [{ filename: CHUNK_FRAME }] }),
      true,
      `expected "${message}" from a chunk frame to be classified as old-browser parse noise`,
    )
  }
})

test('suppresses every old-browser SyntaxError Sentry event whose frame is a minified chunk', () => {
  for (const value of OLD_BROWSER_SYNTAX_PARSE_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://kortix.com/' },
        exception: {
          values: [
            {
              value,
              stacktrace: { frames: [{ filename: CHUNK_FRAME }] },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" from a chunk frame to be suppressed`,
    )
  }
})

test('suppresses an old-browser SyntaxError from a Vercel ?dpl= deploy-hash chunk URL', () => {
  // Old browsers loading a chunk from a Vercel deployment URL also surface the
  // raw `?dpl=dpl_…` filename, not the de-minified source.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: "SyntaxError: Unexpected token '='",
            stacktrace: {
              frames: [
                { filename: 'https://kortix.com/_next/static/chunks/1234-abcd.js?dpl=dpl_abc123' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses an old-browser SyntaxError via the runtime (window.onerror) gate with a chunk filename', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "SyntaxError: Unexpected token '('",
      filename: CHUNK_FRAME,
    }),
    true,
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Cannot use import statement outside a module',
      filename: 'https://kortix.com/_next/static/chunks/main-app.js',
    }),
    true,
  )
})

test('does NOT suppress an old-browser SyntaxError with NO chunk frame (conservative — keep reporting)', () => {
  // Frameless window.onerror / onunhandledrejection captures carry no chunk
  // anchor. The message prefixes are generic, so without a chunk frame we
  // cannot tell old-browser noise from a real eval bug — keep reporting.
  for (const message of OLD_BROWSER_SYNTAX_PARSE_EVENTS) {
    assert.equal(
      isOldBrowserSyntaxParseError({ message }),
      false,
      `expected frameless "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message }] },
      }),
      false,
      `expected frameless Sentry event for "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a real app SyntaxError from a de-minified first-party frame', () => {
  // A genuine `new Function('…')` / `eval('…')` eval bug in first-party app
  // code throws the SAME wording, but Sentry's sourcemap resolution
  // de-minifies the frame to `apps/web/src/…` — NOT a raw `_next/static/chunks/`
  // path, and not a `?dpl=dpl_…` URL. The matcher must keep reporting it so a
  // real eval regression is never hidden.
  const realAppFrames: Array<{ filename: unknown }> = [
    { filename: 'app:///apps/web/src/lib/dynamic-eval.ts' },
    { filename: 'apps/web/src/lib/dynamic-eval.ts' },
    { filename: 'https://kortix.com/src/lib/dynamic-eval.ts' },
  ]
  for (const frames of [realAppFrames, [{ filename: 'app:///apps/web/src/features/foo.tsx' }]]) {
    for (const message of [
      "SyntaxError: Unexpected token '}'",
      'Invalid or unexpected token',
      'Cannot use import statement outside a module',
    ]) {
      assert.equal(
        isOldBrowserSyntaxParseError({ message, frames }),
        false,
        `expected real app SyntaxError "${message}" from ${JSON.stringify(frames)} to keep reporting`,
      )
    }
  }
  // And via the runtime gate: a first-party filename keeps reporting too.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "SyntaxError: Unexpected token ')'",
      filename: 'app:///apps/web/src/features/foo.tsx',
    }),
    false,
  )
})

// ---------------------------------------------------------------------------
// "No error message" + unresolved minified chunk frames (Better Stack
// patterns a81b7cd3… / 576172fbd8… in chunk 21544-ac9e889808bbe0af.js).
// ---------------------------------------------------------------------------

const CHUNK_21544 = 'app:///_next/static/chunks/21544-ac9e889808bbe0af.js?dpl=dpl_CTqmc8S7CG7w9gkCs2ySzURsbhxm'

test('suppresses the "No error message" + unresolved chunk-21544 Sentry event', () => {
  // Exact shape of the production noise: empty exception value, single frame
  // in our numbered app chunk with a `?` function and no source line.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [{ filename: CHUNK_21544, function: '?', lineno: 0 }],
    }),
    true,
  )
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [{ filename: CHUNK_21544, function: '', lineno: undefined }],
    }),
    true,
  )
  // Better Stack displays "No error message" because the SDK sent no value.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: undefined,
            stacktrace: { frames: [{ filename: CHUNK_21544, function: '?', lineno: 0 }] },
          },
        ],
      },
    }),
    true,
  )
})

test('does NOT suppress a real error that has a message', () => {
  // A non-empty message is always actionable, even if its frame is unresolved.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: 'TypeError: Cannot read properties of null (reading \'getItem\')',
      frames: [{ filename: CHUNK_21544, function: '?', lineno: 0 }],
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: 'Something went wrong',
            stacktrace: { frames: [{ filename: CHUNK_21544, function: '?', lineno: 0 }] },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress an empty-message error whose frame resolves to a source line', () => {
  // `throw new Error()` / `Promise.reject(new Error())` in first-party code:
  // sourcemaps resolve the frame to a real file:line → actionable, keep it.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [{ filename: CHUNK_21544, function: 'handleClick', lineno: 42 }],
    }),
    false,
  )
  // Mixed: one unresolved chunk frame + one resolved frame → keep.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [
        { filename: CHUNK_21544, function: '?', lineno: 0 },
        { filename: 'app:///_next/static/chunks/76904-c52ab52c4900447c.js', function: 'render', lineno: 17 },
      ],
    }),
    false,
  )
})

test('does NOT suppress an empty-message error with a non-browser-bundle frame', () => {
  // Extension / injected / cross-origin frames must not be hidden by this
  // guard — only our own unresolved browser-bundle chunks qualify.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [{ filename: 'chrome-extension://abc/content.js', function: '?', lineno: 0 }],
    }),
    false,
  )
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [
        { filename: CHUNK_21544, function: '?', lineno: 0 },
        { filename: 'https://evil.example/injected.js', function: '?', lineno: 0 },
      ],
    }),
    false,
  )
})

test('does NOT suppress a frameless empty-message event (origin unverifiable)', () => {
  // No frames at all → can't confirm it's our browser chunk; keep reporting.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({ message: '', frames: [] }),
    false,
  )
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({ message: '' }),
    false,
  )
})

// Reproduces the Paper Shaders (`@paper-design/shaders-react`) null-WebGL2-
// context crash class — the `getSupportedExtensions` null-context path that
// ESCAPES `<ShaderSafe>` (Better Stack pattern `34127fa4…`, call site `new b2`
// in chunk `app:///_next/static/chunks/c76173f0.5ba9c330afa9d53d.js`, prod, 2
// occurrences, last 2026-07-12 15:23:38 UTC) plus its known sibling
// `getAttribLocation`. Paper Shaders' shader-mount `useEffect`/rAF callback
// calls a WebGL2 context method on a context that became `null` after a
// context-loss / GPU-blacklist event; the throw is in an async callback so the
// React error boundary can't catch it → global error → Sentry → Better Stack.
// The matcher is the leak-path backstop; the `supportsWebGL2()` probe in
// `shader-safe.tsx` is the primary guard.
const PAPER_SHADER_NULL_CONTEXT_MESSAGES = [
  "Cannot read properties of null (reading 'getSupportedExtensions')",
  "TypeError: Cannot read properties of null (reading 'getSupportedExtensions')",
  "Unhandled promise rejection: TypeError: Cannot read properties of null (reading 'getSupportedExtensions')",
  "Cannot read properties of null (reading 'getAttribLocation')",
  "TypeError: Cannot read properties of null (reading 'getAttribLocation')",
  "Unhandled promise rejection: Cannot read properties of null (reading 'getAttribLocation')",
  // Old JSC form.
  "Cannot read property 'getSupportedExtensions' of null",
  "Cannot read property 'getAttribLocation' of null",
]

test('classifies every Paper Shaders null-context WebGL message as noise', () => {
  for (const message of PAPER_SHADER_NULL_CONTEXT_MESSAGES) {
    assert.equal(
      isPaperShaderNullContextNoise(message),
      true,
      `expected "${message}" to be classified as Paper Shaders null-context noise`,
    )
  }
})

test('suppresses every Paper Shaders null-context message via the runtime (window.onerror) gate', () => {
  for (const message of PAPER_SHADER_NULL_CONTEXT_MESSAGES) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message }),
      true,
      `expected runtime gate to suppress "${message}"`,
    )
  }
})

test('suppresses every Paper Shaders null-context message via the Sentry beforeSend gate', () => {
  // The message is specific enough (WebGL2 API method names that first-party
  // app code never calls) that no chunk-frame anchor is required — but the
  // Sentry event usually still carries the chunk frame, so verify both shapes.
  for (const message of PAPER_SHADER_NULL_CONTEXT_MESSAGES) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: message,
              stacktrace: {
                frames: [
                  { filename: 'app:///_next/static/chunks/c76173f0.5ba9c330afa9d53d.js' },
                ],
              },
            },
          ],
        },
      }),
      true,
      `expected Sentry gate to suppress "${message}" with a chunk frame`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message }] },
      }),
      true,
      `expected Sentry gate to suppress "${message}" even with NO chunk frame (message is specific enough)`,
    )
  }
})

test('does NOT suppress a real app TypeError with a different null-property name', () => {
  // A genuine first-party `foo.bar` null-deref regression throws the same
  // `Cannot read properties of null (reading '<name>')` SHAPE but with an
  // app-property name, not a WebGL2 API method — it must keep reporting so a
  // real null-deref regression is never hidden by the Paper Shaders guard.
  const realAppNullDerefMessages = [
    "Cannot read properties of null (reading 'map')",
    "Cannot read properties of null (reading 'length')",
    "TypeError: Cannot read properties of null (reading 'id')",
    "Cannot read property 'foo' of null",
    // A non-null access on getSupportedExtensions (e.g. typo'd as a property
    // of a non-null object) is a different message and must keep reporting.
    "Cannot read properties of undefined (reading 'getSupportedExtensions')",
  ]
  for (const message of realAppNullDerefMessages) {
    assert.equal(
      isPaperShaderNullContextNoise(message),
      false,
      `expected real app TypeError "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message }),
      false,
      `expected runtime gate to keep reporting real app TypeError "${message}"`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: message,
              stacktrace: {
                frames: [
                  { filename: 'app:///_next/static/chunks/c76173f0.5ba9c330afa9d53d.js' },
                ],
              },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting real app TypeError "${message}" even from a chunk frame`,
    )
  }
})

// ---------------------------------------------------------------------------
// TronLink browser-extension injected-Proxy `set`-trap noise
// (Better Stack pattern 951c1a316cae8595da3f73877cb1fa8a77d04315ae1a2987b6348a97ec9a049a,
// Kortix Frontend prod, application_id 2346967). The TronLink wallet extension
// injects `app:///injected/injected.js` (function `BI`) which wraps a page
// object in a Proxy exposing `tronlinkParams`; a `set` the trap declines throws
// `TypeError: 'set' on proxy: trap returned falsish for property 'tronlinkParams'`.
// 2 occurrences, 0 identified users, first/last 2026-07-12. The throw is inside
// the EXTENSION's injected script, never first-party code. The matcher requires
// BOTH the TronLink property name AND an injected/extension source so a real
// first-party Proxy `set` failure keeps reporting.
// ---------------------------------------------------------------------------

const TRONLINK_INJECTED_FRAME = { filename: 'app:///injected/injected.js', function: 'BI' }

const TRONLINK_PROXY_EVENTS = [
  // The exact assigned production message (V8/Chrome).
  "TypeError: 'set' on proxy: trap returned falsish for property 'tronlinkParams'",
  // Bare message (no `TypeError:` prefix).
  "'set' on proxy: trap returned falsish for property 'tronlinkParams'",
  // Unhandled-rejection leak path preserving the message.
  "Unhandled promise rejection: TypeError: 'set' on proxy: trap returned falsish for property 'tronlinkParams'",
  // SpiderMonkey (Firefox) wording, same TronLink property.
  "proxy set handler returned false for property 'tronlinkParams'",
  "TypeError: proxy set handler returned false for property 'tronlinkParams'",
]

test('classifies every TronLink proxy-trap variant as noise when sourced from the injected script', () => {
  for (const message of TRONLINK_PROXY_EVENTS) {
    assert.equal(
      isTronLinkProxyNoise({ message, filename: 'app:///injected/injected.js' }),
      true,
      `expected "${message}" from injected.js to be TronLink noise`,
    )
    assert.equal(
      isTronLinkProxyNoise({ message, frames: [TRONLINK_INJECTED_FRAME] }),
      true,
      `expected "${message}" with an injected frame to be TronLink noise`,
    )
  }
})

test('classifies TronLink proxy-trap noise from a chrome-extension:// frame', () => {
  assert.equal(
    isTronLinkProxyNoise({
      message: "TypeError: 'set' on proxy: trap returned falsish for property 'tronlinkParams'",
      frames: [{ filename: 'chrome-extension://egjidmnggjknjgkbjopmfcfhkagpnbgh/injected.js' }],
    }),
    true,
  )
})

test('suppresses the TronLink proxy-trap Sentry event from the injected script', () => {
  for (const value of TRONLINK_PROXY_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://app.kortix.com/projects' },
        exception: {
          values: [
            {
              value,
              stacktrace: { frames: [TRONLINK_INJECTED_FRAME] },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses the TronLink proxy-trap unhandled rejection from the browser (window.onerror)', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        "Unhandled promise rejection: TypeError: 'set' on proxy: trap returned falsish for property 'tronlinkParams'",
      filename: 'app:///injected/injected.js',
    }),
    true,
  )
})

test('does NOT suppress a TronLink-worded event with NO injected/extension source (conservative — keep reporting)', () => {
  // No source anchor → can't confirm extension origin; a first-party Proxy
  // could theoretically throw the same wording, so keep reporting.
  for (const value of TRONLINK_PROXY_EVENTS) {
    assert.equal(
      isTronLinkProxyNoise({ message: value }),
      false,
      `expected frameless "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      false,
      `expected frameless Sentry event for "${value}" to keep reporting`,
    )
  }
})

test('does NOT suppress a TronLink-worded event from a first-party app frame', () => {
  // A genuine first-party Proxy `set` trap returning falsish (MobX/Immer/
  // Zustand/hand-rolled Proxy) throws the SAME wording but inside app code —
  // the de-minified frame is `apps/web/src/…`, not the extension's injected
  // script. It must keep reporting so a real Proxy bug is never hidden.
  const realAppFrames: Array<{ filename: unknown }> = [
    { filename: 'app:///apps/web/src/lib/store.ts' },
    { filename: 'apps/web/src/lib/store.ts' },
    { filename: 'https://app.kortix.com/_next/static/chunks/store.js' },
  ]
  for (const frames of [realAppFrames, [{ filename: 'app:///_next/static/chunks/app.js' }]]) {
    assert.equal(
      isTronLinkProxyNoise({
        message: "TypeError: 'set' on proxy: trap returned falsish for property 'tronlinkParams'",
        frames,
      }),
      false,
      `expected TronLink-worded event from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: "'set' on proxy: trap returned falsish for property 'tronlinkParams'",
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting TronLink-worded event from ${JSON.stringify(frames)}`,
    )
  }
  // And via the runtime gate: a first-party filename keeps reporting too.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "'set' on proxy: trap returned falsish for property 'tronlinkParams'",
      filename: 'app:///apps/web/src/lib/store.ts',
    }),
    false,
  )
})

test('does NOT suppress a real first-party Proxy `set` failure on a DIFFERENT property', () => {
  // The generic `'set' on proxy: trap returned falsish for property '<X>'`
  // wording with a non-TronLink property name is a real app Proxy bug — even
  // from the injected script frame, the property name is the TronLink marker,
  // so a different property must keep reporting regardless of source.
  for (const value of [
    "'set' on proxy: trap returned falsish for property 'foo'",
    "TypeError: 'set' on proxy: trap returned falsish for property 'bar'",
    "'set' on proxy: trap returned falsish for property 'tronlinkParams_extra'",
  ]) {
    assert.equal(
      isTronLinkProxyNoise({ message: value, filename: 'app:///injected/injected.js' }),
      false,
      `expected non-TronLink Proxy message "${value}" to keep reporting`,
    )
  }
})

// Reproduces Better Stack error e6a45fe4999b5a60f5cd64fd4153b18c2beebfc4409a3d54da456a4bbc24e5d2
// (Kortix Frontend prod, application_id 2346967): 1 occurrence, 0 identified
// users, 2026-07-12 19:31:47 UTC. A Threads (Barcelona) in-app Android WebView
// (Android 14 / Chrome 149, referer https://l.threads.com/) visited the
// marketing homepage (`https://kortix.com/`). The Android System WebView
// injects a synthetic `app://navigation_performance_logger_android` script
// that records navigation timing (FBNavResponseStart / FBNavDomContentLoaded /
// …) and ships it to its native Java bridge via `sendDataToNative` →
// `postMessage`. The bridge holds only a WEAK reference to the Java object,
// so once it is garbage-collected (page navigation / WebView teardown / the
// in-app browser dismissing the tab) the next `postMessage` throws
// `Error invoking postMessage: Java object is gone`. Sentry's
// `BrowserApiErrors` integration auto-wraps `addEventListener` on
// `EventTarget` and captures the throw as a global error. The frames (Sentry
// oldest-first → last is the throwing frame) are the Android bridge internals:
//   app:///_next/static/chunks/66499-…?dpl=dpl_…   (Sentry wrapper frame `u`)
//   app://navigation_performance_logger_android   `?`
//   app://navigation_performance_logger_android   `sendJsBlockingTimeMessage`
//   app://navigation_performance_logger_android   `sendDataToNative`  (throw)
// This is the WebView's OWN instrumentation, never first-party code. The
// matcher requires BOTH the exact message AND a frame whose filename is the
// Android bridge source, so a genuine first-party `window.postMessage`
// failure keeps reporting.
const ANDROID_NAV_PERF_LOGGER_FRAME = 'app://navigation_performance_logger_android'
const ANDROID_WEBVIEW_BRIDGE_EVENTS = [
  // The exact raw exception value from the production event.
  'Error invoking postMessage: Java object is gone',
  // An unhandled-rejection wrapper preserving the message.
  'Unhandled promise rejection: Error invoking postMessage: Java object is gone',
]

test('classifies the Android WebView native-bridge postMessage noise (with a bridge frame)', () => {
  for (const message of ANDROID_WEBVIEW_BRIDGE_EVENTS) {
    assert.equal(
      isAndroidWebViewNativeBridgePostMessageNoise({
        message,
        frames: [{ filename: ANDROID_NAV_PERF_LOGGER_FRAME }],
      }),
      true,
      `expected "${message}" from the Android bridge frame to be classified as noise`,
    )
  }
})

test('suppresses the Android WebView bridge Sentry event via the beforeSend gate', () => {
  // Exact frame chain from the raw production event (oldest-first → throwing
  // frame last).
  for (const value of ANDROID_WEBVIEW_BRIDGE_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://kortix.com/' },
        exception: {
          values: [
            {
              value,
              stacktrace: {
                frames: [
                  {
                    filename:
                      'app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy',
                    function: 'u',
                  },
                  { filename: ANDROID_NAV_PERF_LOGGER_FRAME, function: '?' },
                  {
                    filename: ANDROID_NAV_PERF_LOGGER_FRAME,
                    function: 'sendJsBlockingTimeMessage',
                  },
                  {
                    filename: ANDROID_NAV_PERF_LOGGER_FRAME,
                    function: 'sendDataToNative',
                  },
                ],
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

test('suppresses the Android WebView bridge noise via the runtime (window.onerror) gate with a bridge filename', () => {
  for (const message of ANDROID_WEBVIEW_BRIDGE_EVENTS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({
        message,
        filename: ANDROID_NAV_PERF_LOGGER_FRAME,
      }),
      true,
      `expected runtime gate to suppress "${message}" with the Android bridge filename`,
    )
  }
})

test('does NOT suppress the Android bridge message with NO bridge frame (conservative — keep reporting)', () => {
  // The message wording is generic enough that a real first-party
  // `window.postMessage` failure could share it; without the Android bridge
  // frame/filename we cannot confirm origin — keep reporting.
  for (const message of ANDROID_WEBVIEW_BRIDGE_EVENTS) {
    assert.equal(
      isAndroidWebViewNativeBridgePostMessageNoise({ message }),
      false,
      `expected frameless "${message}" to keep reporting`,
    )
    assert.equal(
      isAndroidWebViewNativeBridgePostMessageNoise({
        message,
        frames: [{ filename: 'app:///_next/static/chunks/main.js' }],
      }),
      false,
      `expected "${message}" from an app chunk (no bridge frame) to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message }] },
      }),
      false,
      `expected frameless Sentry event for "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a real first-party postMessage failure that throws from an app chunk', () => {
  // A genuine `window.postMessage` / structured-clone failure in our own code
  // throws the SAME message wording, but from an `app:///_next/…` chunk (or a
  // de-minified `apps/web/src/…` frame), NEVER from the Android bridge source.
  // It must keep reporting so a real postMessage regression is never hidden.
  const realAppFrames: Array<{ filename: unknown }> = [
    { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js' },
    { filename: 'apps/web/src/features/messaging/postmessage-bridge.ts' },
  ]
  for (const frames of [realAppFrames, [{ filename: 'app:///apps/web/src/features/messaging/bridge.ts' }]]) {
    assert.equal(
      isAndroidWebViewNativeBridgePostMessageNoise({
        message: 'Error invoking postMessage: Java object is gone',
        frames,
      }),
      false,
      `expected real first-party postMessage error from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: 'Error invoking postMessage: Java object is gone',
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting real first-party postMessage error from ${JSON.stringify(frames)}`,
    )
  }
  // And via the runtime gate: a first-party filename keeps reporting too.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Error invoking postMessage: Java object is gone',
      filename: 'apps/web/src/features/messaging/postmessage-bridge.ts',
    }),
    false,
  )
})

test('does NOT suppress a same-worded message from a different bridge / non-Android source', () => {
  // The matcher is anchored on the EXACT `app://navigation_performance_logger_android`
  // source — a near-identical filename (e.g. a hypothetical iOS sibling or a
  // typo) must NOT be swallowed by this guard.
  assert.equal(
    isAndroidWebViewNativeBridgePostMessageNoise({
      message: 'Error invoking postMessage: Java object is gone',
      frames: [{ filename: 'app://navigation_performance_logger_ios' }],
    }),
    false,
  )
    assert.equal(
      isAndroidWebViewNativeBridgePostMessageNoise({
        message: 'Error invoking postMessage: Java object is gone',
        frames: [{ filename: 'app://navigation_performance_logger_androidx' }],
      }),
      false,
    )
})

// ---------------------------------------------------------------------------
// iOS-WebKit stack-overflow noise
// (Better Stack pattern 87ccbef98ea62fbf90df2446141a26b78ba7f928a28642b099d53b40e8613031,
// Kortix Frontend prod, application_id 2346967). iOS WebKit (Safari,
// Chrome-on-iOS, Google Search App — all WKWebView/JSC) surfaces
// `RangeError: Maximum call stack size exceeded.` through `window.onerror`
// (Sentry mechanism `auto.browser.global_handlers.onerror`) with NO usable
// stack: the single exception frame is the synthetic
// `{ function: '?', filename: 'undefined', lineno: <n> }` placeholder, so
// `call_site_file` is `undefined` and `call_site_function` is `?`. ~30
// lifetime occurrences, 0 identified users, first 2026-04-21 / last
// 2026-07-14, 100% iOS across 7 releases over 2.5 months — browser/engine
// noise, NOT a deterministic app regression. The matcher is anchored on the
// canonical message AND the absence of ANY resolvable source location so a
// real first-party (or third-party) recursion that carries a real chunk/URL/
// `apps/web/src/…` frame keeps reporting.
// ---------------------------------------------------------------------------

// The exact synthetic frame the iOS-WebKit global-onerror capture produces —
// pulled verbatim from the production raw exception payload.
const IOS_STACK_OVERFLOW_SYNTHETIC_FRAME = { function: '?', filename: 'undefined', lineno: 31 }
const IOS_STACK_OVERFLOW_MESSAGES = [
  'Maximum call stack size exceeded.',
  'RangeError: Maximum call stack size exceeded.',
  'Unhandled promise rejection: RangeError: Maximum call stack size exceeded.',
]

test('classifies the iOS-WebKit stack-overflow capture as noise', () => {
  for (const message of IOS_STACK_OVERFLOW_MESSAGES) {
    assert.equal(
      isUnresolvableStackOverflowNoise({
        message,
        frames: [IOS_STACK_OVERFLOW_SYNTHETIC_FRAME],
      }),
      true,
      `expected "${message}" with the synthetic undefined frame to be noise`,
    )
  }
})

test('suppresses the iOS-WebKit stack-overflow noise via the Sentry beforeSend gate', () => {
  // The exact production event shape: single synthetic `{ filename: 'undefined' }`
  // frame captured by Sentry's GlobalHandlers (window.onerror) integration.
  for (const message of IOS_STACK_OVERFLOW_MESSAGES) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: message,
              stacktrace: { frames: [IOS_STACK_OVERFLOW_SYNTHETIC_FRAME] },
            },
          ],
        },
      }),
      true,
      `expected Sentry gate to suppress "${message}" with the synthetic undefined frame`,
    )
  }
  // Frameless global-onerror capture (no stacktrace at all) is also noise.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: { values: [{ value: 'Maximum call stack size exceeded.' }] },
    }),
    true,
  )
})

test('suppresses the iOS-WebKit stack-overflow noise via the runtime (window.onerror) gate', () => {
  // window.onerror for the noise capture carries no resolvable filename
  // (event.filename is undefined/empty) — the engine truncated the stack.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({ message: 'Maximum call stack size exceeded.' }),
    true,
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Maximum call stack size exceeded.',
      filename: '',
    }),
    true,
  )
})

test('does NOT suppress a real first-party RangeError recursion with a resolved apps/web/src frame', () => {
  // A genuine infinite recursion in our own code still produces a real stack;
  // Sentry's sourcemap resolution rewrites the top frame back to
  // `apps/web/src/…`. The negative guard MUST preserve it so the call site can
  // be found + fixed — this is the whole reason the matcher is frame-aware.
  for (const frames of [
    [{ filename: 'apps/web/src/features/co-worker/recursion-loop.ts', function: 'deepRecurse' }],
    [
      { filename: 'apps/web/src/features/co-worker/recursion-loop.ts', function: 'deepRecurse' },
      IOS_STACK_OVERFLOW_SYNTHETIC_FRAME,
    ],
  ]) {
    assert.equal(
      isUnresolvableStackOverflowNoise({
        message: 'Maximum call stack size exceeded.',
        frames,
      }),
      false,
      `expected real first-party recursion with frames ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: 'Maximum call stack size exceeded.',
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting real first-party recursion with frames ${JSON.stringify(frames)}`,
    )
  }
  // And via the runtime gate: a first-party filename keeps reporting too.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Maximum call stack size exceeded.',
      filename: 'apps/web/src/features/co-worker/recursion-loop.ts',
    }),
    false,
  )
})

// ---------------------------------------------------------------------------
// EVM-wallet-extension injected `inpage.js` stream EventEmitter noise
// (Better Stack patterns 17a0ce67ca03dd51cfa5a9a1ac7e5140a958664a5f66ac8ec74c40604ffd772a
// (`Cannot read properties of undefined (reading 'addListener')`, 21 occ.)
// and 3a6b00dc85a3e75f08efab371960c60f74beb2c18059a7f9bcffe409c2591ce6
// (`Cannot read properties of undefined (reading 'emit')`, 4 occ.),
// Kortix Frontend prod, application_id 2346967). EVM wallet extensions
// (MetaMask + derivatives) inject `app:///inpage.js` whose provider stream is
// `@metamask/post-message-stream`'s `ExtendedBroadcastMessage` (an
// EventEmitter subclass). During extension init / port-teardown races the
// underlying stream/port is `undefined`, so an `.addListener` / `.emit` call
// throws inside `app:///inpage.js` (frames `?` / `fulfilled` /
// `ExtendedBroadcastMessage.<anonymous>`). 0 identified users, first/last
// 2026-07-14, request URL `https://kortix.com/`, Chrome 150. The throw is in
// the EXTENSION's injected script, never first-party code. The matcher
// requires BOTH one of the exact message markers AND an `app:///inpage.js` /
// extension source so a real first-party `.addListener`/`.emit` TypeError
// keeps reporting.
// ---------------------------------------------------------------------------

const INPAGE_WALLET_INJECTED_FRAME = { filename: 'app:///inpage.js', function: '?' }
const INPAGE_WALLET_EMIT_FRAME_CHAIN = [
  { filename: 'app:///inpage.js', function: 'fulfilled' },
  { filename: '<anonymous>', function: 'Generator.next' },
  { filename: 'app:///inpage.js', function: 'ExtendedBroadcastMessage.<anonymous>' },
]

const INPAGE_WALLET_STREAM_EVENTS = [
  // The exact raw exception values from the two production events (V8/Chrome).
  "Cannot read properties of undefined (reading 'addListener')",
  "Cannot read properties of undefined (reading 'emit')",
  // `TypeError:` prefixed (window.onerror / onunhandledrejection paths).
  "TypeError: Cannot read properties of undefined (reading 'addListener')",
  "TypeError: Cannot read properties of undefined (reading 'emit')",
  // Unhandled-rejection leak path preserving the message.
  "Unhandled promise rejection: TypeError: Cannot read properties of undefined (reading 'addListener')",
  "Unhandled promise rejection: TypeError: Cannot read properties of undefined (reading 'emit')",
  // Old JSC (Safari) wording, same wallet-extension class.
  "Cannot read property 'addListener' of undefined",
  "TypeError: Cannot read property 'emit' of undefined",
]

test('classifies every inpage.js wallet-stream variant as noise when sourced from the injected script', () => {
  for (const message of INPAGE_WALLET_STREAM_EVENTS) {
    assert.equal(
      isInpageWalletStreamNoise({ message, filename: 'app:///inpage.js' }),
      true,
      `expected "${message}" from inpage.js to be wallet-stream noise`,
    )
    assert.equal(
      isInpageWalletStreamNoise({ message, frames: [INPAGE_WALLET_INJECTED_FRAME] }),
      true,
      `expected "${message}" with an injected frame to be wallet-stream noise`,
    )
  }
})

test('classifies the emit variant from the full ExtendedBroadcastMessage frame chain', () => {
  assert.equal(
    isInpageWalletStreamNoise({
      message: "Cannot read properties of undefined (reading 'emit')",
      frames: INPAGE_WALLET_EMIT_FRAME_CHAIN,
    }),
    true,
  )
})

test('classifies inpage.js wallet-stream noise from a chrome-extension:// frame', () => {
  assert.equal(
    isInpageWalletStreamNoise({
      message: "TypeError: Cannot read properties of undefined (reading 'emit')",
      frames: [{ filename: 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js' }],
    }),
    true,
  )
})

test('suppresses the inpage.js wallet-stream Sentry event via the beforeSend gate', () => {
  for (const value of INPAGE_WALLET_STREAM_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://kortix.com/' },
        exception: {
          values: [
            {
              value,
              stacktrace: { frames: INPAGE_WALLET_EMIT_FRAME_CHAIN },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses the inpage.js wallet-stream unhandled rejection from the browser (window.onerror)', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        "Unhandled promise rejection: TypeError: Cannot read properties of undefined (reading 'addListener')",
      filename: 'app:///inpage.js',
    }),
    true,
  )
})

test('does NOT suppress an inpage.js wallet-stream event with NO injected/extension source (conservative — keep reporting)', () => {
  // No source anchor → can't confirm extension origin; a first-party emitter
  // could theoretically throw the same wording, so keep reporting.
  for (const value of INPAGE_WALLET_STREAM_EVENTS) {
    assert.equal(
      isInpageWalletStreamNoise({ message: value }),
      false,
      `expected frameless "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      false,
      `expected frameless Sentry event for "${value}" to keep reporting`,
    )
  }
})

test('does NOT suppress an inpage.js wallet-stream event from a first-party app frame', () => {
  // A genuine first-party emitter bug (Node `EventEmitter` / `mitt` /
  // `nanoevents` / hand-rolled emitter) throws the SAME wording but inside
  // app code — the de-minified frame is `apps/web/src/…` (or an
  // `app:///_next/…` chunk), never the extension's `app:///inpage.js`. It
  // must keep reporting so a real emitter bug is never hidden.
  const realAppFrames: Array<{ filename: unknown }> = [
    { filename: 'app:///apps/web/src/lib/event-bus.ts' },
    { filename: 'apps/web/src/lib/event-bus.ts' },
    { filename: 'https://app.kortix.com/_next/static/chunks/event-bus.js' },
  ]
  for (const frames of [realAppFrames, [{ filename: 'app:///_next/static/chunks/app.js' }]]) {
    assert.equal(
      isInpageWalletStreamNoise({
        message: "TypeError: Cannot read properties of undefined (reading 'emit')",
        frames,
      }),
      false,
      `expected wallet-stream-worded event from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: "Cannot read properties of undefined (reading 'addListener')",
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting wallet-stream-worded event from ${JSON.stringify(frames)}`,
    )
  }
  // And via the runtime gate: a first-party filename keeps reporting too.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "Cannot read properties of undefined (reading 'emit')",
      filename: 'apps/web/src/lib/event-bus.ts',
    }),
    false,
  )
})

test('does NOT suppress a real first-party TypeError on a DIFFERENT method name from inpage.js', () => {
  // The generic `Cannot read properties of undefined (reading '<X>')` wording
  // with a non-`addListener`/`emit` method name is NOT the wallet-stream
  // class — even from the injected script frame it must keep reporting, so a
  // different injected-script regression is never hidden by this guard.
  for (const value of [
    "Cannot read properties of undefined (reading 'addEventListener')",
    "TypeError: Cannot read properties of undefined (reading 'on')",
    "Cannot read properties of undefined (reading 'removeListener')",
  ]) {
    assert.equal(
      isInpageWalletStreamNoise({ message: value, filename: 'app:///inpage.js' }),
      false,
      `expected non-wallet-stream message "${value}" to keep reporting`,
    )
  }
})

test('does NOT suppress a same-worded message from a near-miss injected filename', () => {
  // The matcher is anchored on the EXACT `app:///inpage.js` source — a
  // near-identical filename (e.g. a path variant or a typo) must NOT be
  // swallowed by this guard.
  for (const filename of [
    'app:///scripts/inpage.js',
    'app:///inpage.min.js',
    'app://inpage.js',
    'app:///injected/inpage.js',
  ]) {
    assert.equal(
      isInpageWalletStreamNoise({
        message: "Cannot read properties of undefined (reading 'emit')",
        frames: [{ filename }],
      }),
      false,
      `expected "${filename}" frame to keep reporting`,
    )
  }
})

test('does NOT suppress a real recursion that carries a resolvable chunk/URL frame', () => {
  // A real recursion — even a third-party one — surfaces with at least one real
  // chunk/URL source location (the engine recorded where it overflowed). The
  // negative guard preserves it; only the frameless synthetic-`undefined`
  // capture is dropped.
  const realFrames: Array<{ filename: unknown }> = [
    { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js' },
    { filename: 'https://kortix.com/_next/static/chunks/main-abc.js' },
    { filename: 'app:///apps/web/src/lib/something.ts' },
  ]
  for (const frame of realFrames) {
    assert.equal(
      isUnresolvableStackOverflowNoise({
        message: 'Maximum call stack size exceeded.',
        frames: [frame, IOS_STACK_OVERFLOW_SYNTHETIC_FRAME],
      }),
      false,
      `expected real recursion with frame ${JSON.stringify(frame)} to keep reporting`,
    )
  }
  // Runtime gate with a real chunk filename keeps reporting too.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Maximum call stack size exceeded.',
      filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js',
    }),
    false,
  )
})

test('does NOT suppress a different RangeError message', () => {
  // A RangeError with a different message (e.g. an invalid array length) is a
  // different, actionable error class — never matched by this guard.
  for (const message of [
    'Invalid array length',
    'RangeError: Invalid array length',
    'Maximum call stack', // prefix-only, not the canonical message
  ]) {
    assert.equal(
      isUnresolvableStackOverflowNoise({
        message,
        frames: [IOS_STACK_OVERFLOW_SYNTHETIC_FRAME],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
  }
})
