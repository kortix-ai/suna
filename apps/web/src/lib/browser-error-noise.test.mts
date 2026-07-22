import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isAndroidWebViewNativeBridgePostEventNoise,
  isAndroidWebViewNativeBridgePostMessageNoise,
  isClientRequestTimeoutMessage,
  isEmptyMessageUnresolvedBrowserChunkNoise,
  isEmbedPdfTilingReactUpdateDepthNoise,
  isExpectedBillingGateMessage,
  isExpectedCompactionNoModelMessage,
  isExtensionRejectedObjectNoise,
  isExtensionSource,
  isFirefoxReactSchedulerReentryNoise,
  isInjectedAppSource,
  isInpageWalletStreamNoise,
  isKnownBrowserNoiseMessage,
  isNonErrorUndefinedRejectionNoise,
  isOldBrowserSyntaxParseError,
  isOldWebkitRegexNoiseMessage,
  isPaperShaderNullContextNoise,
  isRuntimeNotReadyNoiseMessage,
  isStaleWebpackRuntimeCallNoise,
  isStorageDisabledWebViewNoiseMessage,
  isStorageSecurityErrorNoise,
  isTronLinkProxyNoise,
  isUnresolvableStackOverflowNoise,
  isUserscriptManagerNoise,
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

// Reproduces Better Stack error 9f72dd9a2cb49a81aa57be27e9b3cb2f1ef06a8ebf59ede6900267febd3f7ded
// (Kortix Frontend prod): the SDK's `useSummarizeOpenCodeSession` mutation
// threw a plain `Error('No model available for compaction. …')` when every
// model-resolution fallback tier failed (no config default, no assistant
// message, no connected provider/model) — an EXPECTED, user-facing
// configuration state the host already surfaces via the `loadingToast` error
// toast. It leaked to Sentry as an unhandled promise rejection:
// `compact-modal.tsx` fires `void loadingToast(() => summarize.mutateAsync(...))`,
// `loadingToast` re-throws the error after showing the toast (toast.tsx), and
// the `void`-fired rejection is auto-captured by Sentry's `onunhandledrejection`
// integration. The SDK now throws a sentinel `NoCompactionModelError` (same
// message + `name`) so this gate can match it precisely and drop it across
// every capture path. A longer real mutation failure that merely mentions the
// wording keeps reporting.
const COMPACTION_NO_MODEL_EVENTS = [
  // The sentinel error's own message.
  'No model available for compaction. Please configure a model in settings.',
  // An `Error:`-prefixed wrapper (e.g. a console/error-boundary re-throw).
  'Error: No model available for compaction. Please configure a model in settings.',
  // An unhandled-rejection wrapper preserving the message (Sentry auto-capture).
  'Unhandled promise rejection: No model available for compaction. Please configure a model in settings.',
  // An unhandled-rejection wrapper around an `Error:`-prefixed re-throw.
  'Unhandled promise rejection: Error: No model available for compaction. Please configure a model in settings.',
]

test('classifies the no-compaction-model configuration state as expected', () => {
  for (const message of COMPACTION_NO_MODEL_EVENTS) {
    assert.equal(
      isExpectedCompactionNoModelMessage(message),
      true,
      `expected "${message}" to be classified as an expected no-compaction-model message`,
    )
  }
})

test('suppresses a no-compaction-model Sentry event regardless of capture path', () => {
  for (const value of COMPACTION_NO_MODEL_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://app.kortix.com/projects/p/sessions/s' },
        exception: {
          values: [
            {
              value,
              stacktrace: {
                frames: [{ filename: 'app:///_next/static/chunks/73448-9ebd1b3ca69703dd.js' }],
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

test('suppresses a no-compaction-model unhandled rejection from the browser', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        'Unhandled promise rejection: No model available for compaction. Please configure a model in settings.',
    }),
    true,
  )
})

test('does NOT suppress a longer real error containing the compaction wording', () => {
  for (const value of [
    'Failed to compact session: No model available for compaction. Please configure a model in settings.',
    'No model available for compaction. Please configure a model in settings. while summarizing',
    'Error: No model available for compaction. Please configure a model in settings. and more',
    'Unhandled promise rejection: Something else: No model available for compaction. Please configure a model in settings.',
  ]) {
    assert.equal(
      isExpectedCompactionNoModelMessage(value),
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

test('does NOT suppress a real compaction mutation failure (network / 5xx)', () => {
  for (const value of [
    'Internal server error',
    'HTTP 500: Internal Server Error',
    'TypeError: Cannot read properties of undefined (reading providerID)',
    'Failed to fetch',
  ]) {
    assert.equal(
      isExpectedCompactionNoModelMessage(value),
      false,
      `expected real error "${value}" to keep reporting`,
    )
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
//
// POST-#4674 RECURRENCE (this PR): the host name in the browser's throw is the
// `Window` global interface, which different browsers capitalize differently.
// PR #4674 matched only the lowercase `from 'window'` wording (Chrome), so the
// capitalized `from 'Window'` form (Firefox/WebKit) kept slipping through and
// re-fired in prod as patterns `89b0a8e8…` / `b6927c9d…` (last 2026-07-21) plus
// older `e8eadc82…` / `d010de8a…` (last 2026-07-19), all from the webpack runtime
// chunk `app:///_next/static/chunks/webpack-d1f7215451c1ce17.js` function `c`
// (= `__webpack_require__`) in a storage-blocked context. The `Window` variants
// below reproduce those exact messages; the matcher now classifies both
// casings (host token is matched case-insensitively). See the new
// `classifies the capitalized 'Window' storage SecurityError variants …` test.
const STORAGE_SECURITY_ERROR_EVENTS = [
  // The exact raw production message (localStorage, Chrome `from 'window'`).
  "SecurityError: Failed to read the 'localStorage' property from 'window': Access is denied for this document.",
  // Bare message (no `SecurityError:` prefix).
  "Failed to read the 'localStorage' property from 'window': Access is denied for this document.",
  // Unhandled-rejection leak path preserving the message.
  "Unhandled promise rejection: SecurityError: Failed to read the 'localStorage' property from 'window': Access is denied for this document.",
  // The sessionStorage sibling variant (same root class, same instant).
  "SecurityError: Failed to read the 'sessionStorage' property from 'window': Access is denied for this document.",
  "Failed to read the 'sessionStorage' property from 'window': Access is denied for this document.",
  "Unhandled promise rejection: Failed to read the 'sessionStorage' property from 'window': Access is denied for this document.",
  // Firefox/WebKit capitalize the host interface name: `from 'Window'`. These
  // are the exact post-#4674 recurrence messages (patterns `89b0a8e8…` /
  // `b6927c9d…` / `e8eadc82…` / `d010de8a…`).
  "SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
  "Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
  "Unhandled promise rejection: SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
  "SecurityError: Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document.",
  "Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document.",
  "Unhandled promise rejection: Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document.",
]

// A raw minified chunk frame (no resolved `apps/web/src/…` source) — the
// browser-environment noise shape: storage blocked, no traceable first-party
// call site. Should be suppressed.
const CHUNK_FRAME_STORAGE = 'app:///_next/static/chunks/21544-ac9e889808bbe0af.js'

// The exact webpack runtime chunk frame from the post-#4674 recurrence
// (patterns `89b0a8e8…` / `b6927c9d…` …), function `c` = `__webpack_require__`,
// with the Vercel `?dpl=` deployment id. No resolved first-party source, so the
// negative guard does NOT preserve it — it must be dropped.
const WEBPACK_RUNTIME_FRAME_STORAGE =
  'app:///_next/static/chunks/webpack-d1f7215451c1ce17.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno'

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

// Regression for the post-#4674 recurrence: PR #4674's matcher anchored on the
// lowercase `from 'window'` wording only, so the capitalized `from 'Window'`
// form (Firefox/WebKit) re-fired in prod from the webpack runtime chunk. This
// pins the EXACT prod call site (webpack-<hash>.js function `c`, with the
// Vercel `?dpl=` deployment id) + the exact capitalized message, so a future
// regression of either the casing or the chunk-frame handling is caught.
test('suppresses the post-#4674 capitalized Window recurrence (webpack runtime chunk, no first-party frame)', () => {
  const messages = [
    "SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
    "Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
    "SecurityError: Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document.",
  ]
  for (const message of messages) {
    // Matcher-level: capitalized host, no first-party frame → noise.
    assert.equal(
      isStorageSecurityErrorNoise({ message }),
      true,
      `expected capitalized "${message}" to be noise`,
    )
    // Matcher-level: the exact webpack runtime chunk frame (no resolved
    // first-party source) → noise.
    assert.equal(
      isStorageSecurityErrorNoise({ message, frames: [{ filename: WEBPACK_RUNTIME_FRAME_STORAGE }] }),
      true,
      `expected capitalized "${message}" from the webpack runtime chunk to be noise`,
    )
    assert.equal(
      isStorageSecurityErrorNoise({ message, filename: WEBPACK_RUNTIME_FRAME_STORAGE }),
      true,
      `expected capitalized "${message}" from the webpack runtime filename to be noise`,
    )
    // Sentry beforeSend gate: the exact prod Sentry event shape.
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://kortix.com/' },
        exception: {
          values: [
            {
              value: message,
              stacktrace: { frames: [{ filename: WEBPACK_RUNTIME_FRAME_STORAGE }] },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for capitalized "${message}" from the webpack runtime chunk to be suppressed`,
    )
    // Runtime (window.onerror / onunhandledrejection) gate.
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message, filename: WEBPACK_RUNTIME_FRAME_STORAGE }),
      true,
      `expected runtime gate to suppress capitalized "${message}" from the webpack runtime chunk`,
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

test('does NOT suppress an empty-message error whose frame resolves to a first-party source path', () => {
  // `throw new Error()` / `Promise.reject(new Error())` in first-party code:
  // Sentry's sourcemap resolution rewrites the frame filename to a real
  // `apps/web/src/…` source path → actionable, keep it. A named minified
  // function in a RAW chunk path (e.g. `handleClick` in `chunks/21544-…js`)
  // is NOT a resolved source path — the minifier may preserve names, and the
  // lineno is the chunk's single-line bundle line, not a source line — so it
  // does not by itself make an empty-message event actionable. The load-
  // bearing signal is the sourcemap-resolved first-party source path.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [{ filename: 'app:///apps/web/src/features/auth/use-auth.ts', function: 'handleClick', lineno: 42 }],
    }),
    false,
  )
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [{ filename: 'apps/web/src/lib/foo.ts', function: '?', lineno: 0 }],
    }),
    false,
  )
  // Mixed: one unresolved chunk frame + one sourcemap-resolved first-party
  // frame → keep (our own code is the throw site → actionable).
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [
        { filename: CHUNK_21544, function: '?', lineno: 0 },
        { filename: 'app:///apps/web/src/components/markdown/unified-markdown.tsx', function: 'render', lineno: 17 },
      ],
    }),
    false,
  )
  // A named minified function in a RAW chunk path (no `apps/web/src/…`
  // resolution) is NOT actionable on its own — the minifier may preserve
  // names and the lineno is the bundle line, so an empty-message event with
  // only such frames is still the unactionable noise class.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: '',
      frames: [{ filename: CHUNK_21544, function: 'handleClick', lineno: 42 }],
    }),
    true,
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

// ---------------------------------------------------------------------------
// Post-0.10.13 recurrence (Sentry SDK 10.x `"No error message"` placeholder),
// chunk 21544 again. Better Stack patterns:
//   141dcca3d176082360456b74d56119f59acdf806ae0f3ab1e7e7bd8218bca8d2
//     (8 occ / 0 users / last 2026-07-20 21:21:55 UTC, dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2)
//   19ee7c2fe89a3f3302fb8209574d906a7b7c8f04d55746e9b443e9bf078c64ca
//     (6 occ / 0 users / last 2026-07-21 17:03:18 UTC, dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno)
// Siblings in the same now-3d window:
//   8e9a9022fabcc836b3e8f561a722430ff452536daae6b893d2ce3eab406849a9
//     (1 occ / 0 users / last 2026-07-21 01:58:52 UTC)
//   c9457126bec6355b76b4fef6c62f4e212f1271b3f3df6cb80c97a60b8e473305
//     (1 occ / 0 users / last 2026-07-20 06:23:46 UTC)
// All are `auto.browser.global_handlers.onerror` captures whose thrown value
// had no `.message`, so Sentry SDK 10.x (`@sentry/nextjs@10.63.0`) writes the
// literal placeholder string `"No error message"` into
// `exception.values[0].value` (the pre-10.x SDK left it empty/undefined,
// which is the shape #4540's original matcher handled). The frames are mostly
// NAMED minified functions (`iX`/`iu`/`ib`/`ik`/`oq`/`o_`/`l9`/`l`/
// `MessagePort.x`) with real linenos — NOT the all-`?`-and-`lineno:0` shape
// #4540 required — but NONE resolve to a first-party `apps/web/src/…` source
// path (sourcemap resolution produced no first-party source location), so
// there is still no actionable call site. The last frame (chunk 21544, `?`
// function, lineno 1) is the call-site frame Better Stack surfaces.
// ---------------------------------------------------------------------------

// Exact frames of the 2026-07-20 21:21:55 UTC occurrence of pattern
// `141dcca3…` (release `22e12080d2b37642aa92a839da6b37f30fc21b9d`,
// dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2, request `/auth?redirect=…`, Chrome 150).
const CHUNK_66499_BEo2 = 'app:///_next/static/chunks/66499-30a0e6805d268c02.js?dpl=dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2'
const CHUNK_5CCD075D_BEo2 = 'app:///_next/static/chunks/5ccd075d-fe5b6a678bf52bfe.js?dpl=dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2'
const CHUNK_GLOBAL_ERROR_BEo2 = 'app:///_next/static/chunks/app/global-error-ae7fee8d93446b5c.js?dpl=dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2'
const CHUNK_21544_BEo2 = 'app:///_next/static/chunks/21544-ac9e889808bbe0af.js?dpl=dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2'

const PATTERN_141DCCA3_FRAMES = [
  { filename: CHUNK_66499_BEo2, function: 'MessagePort.x', lineno: 3 },
  { filename: CHUNK_5CCD075D_BEo2, function: 'iX', lineno: 1 },
  { filename: CHUNK_5CCD075D_BEo2, function: 'iu', lineno: 1 },
  { filename: CHUNK_5CCD075D_BEo2, function: 'ib', lineno: 1 },
  { filename: CHUNK_5CCD075D_BEo2, function: '?', lineno: 1 },
  { filename: CHUNK_5CCD075D_BEo2, function: 'ik', lineno: 1 },
  { filename: CHUNK_5CCD075D_BEo2, function: 'oq', lineno: 1 },
  { filename: CHUNK_5CCD075D_BEo2, function: 'o_', lineno: 1 },
  { filename: CHUNK_5CCD075D_BEo2, function: 'l9', lineno: 1 },
  { filename: CHUNK_GLOBAL_ERROR_BEo2, function: 'l', lineno: 1 },
  { filename: CHUNK_21544_BEo2, function: '?', lineno: 1 },
]

test('suppresses the post-0.10.13 Sentry 10.x "No error message" placeholder event (pattern 141dcca3…)', () => {
  // The placeholder `"No error message"` is Sentry SDK 10.x's "no message"
  // marker (a window.onerror capture whose thrown value had no `.message`),
  // NOT a real app error message — so it must be treated as empty by the
  // noise matcher. The frames are mostly NAMED minified functions with real
  // linenos but NONE resolve to a first-party `apps/web/src/…` source path,
  // so there is no actionable call site. The event is the same unactionable
  // noise class #4540 suppressed for the pre-10.x empty-value shape.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: 'No error message',
      frames: PATTERN_141DCCA3_FRAMES,
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/auth?redirect=%2Fprojects%2F038ce7cd-c239-47eb-9ad3-83f2e5345aa6%2Fthread%2F75e8053d-85f9-4f18-a6e5-2ac4f0600e44' },
      exception: {
        values: [
          {
            value: 'No error message',
            stacktrace: { frames: PATTERN_141DCCA3_FRAMES },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the sibling post-0.10.13 pattern 19ee7c2f… (different dpl, same shape)', () => {
  // Same shape as 141dcca3… but a different Vercel deployment id
  // (dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno) and release
  // (470fe6f3c88460212c3b187f6f86fb4ad456c4d6). Confirms the matcher is not
  // anchored on one specific dpl/release hash.
  const dpl = 'dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno'
  const frames = PATTERN_141DCCA3_FRAMES.map((f) => ({
    ...f,
    filename: f.filename.replace(/dpl=dpl_[A-Za-z0-9]+/, `dpl=${dpl}`),
  }))
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: 'No error message',
      frames,
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/auth?redirect=%2Fprojects%2F59aa5850-de1d-4e56-81fb-34d532146f01%2Fthread%2F2149cad0-e79e-4d38-84ac-273364cfb434' },
      exception: {
        values: [
          {
            value: 'No error message',
            stacktrace: { frames },
          },
        ],
      },
    }),
    true,
  )
})

test('does NOT suppress a "No error message" event whose frame resolves to a first-party source path', () => {
  // A real `throw new Error()` / `Promise.reject(new Error())` in first-party
  // code de-minifies (via uploaded sourcemaps) to an `apps/web/src/…` frame —
  // even when the Sentry 10.x placeholder `"No error message"` is the value.
  // The first-party source resolution is the load-bearing actionable signal.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: 'No error message',
      frames: [
        ...PATTERN_141DCCA3_FRAMES.slice(0, 5),
        { filename: 'app:///apps/web/src/components/markdown/unified-markdown.tsx', function: 'highlightAsync', lineno: 142 },
      ],
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: 'No error message',
            stacktrace: {
              frames: [
                { filename: 'apps/web/src/lib/foo.ts' },
              ],
            },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress a "No error message" event with a non-browser-bundle frame', () => {
  // A wallet-extension `app:///inpage.js` frame at the top of the stack (the
  // EVM-wallet onGlobalMessage → runIfPresent → run → our chunk chain, e.g.
  // sibling pattern d371a1e2…) is a DIFFERENT noise class with a real
  // extension-origin anchor. Leave it reporting so a future triage can
  // address it specifically; the assigned class (141dcca3…/19ee7c2f…) is
  // pure browser-bundle frames.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: 'No error message',
      frames: [
        { filename: 'app:///inpage.js', function: 'onGlobalMessage', lineno: 59 },
        { filename: 'app:///inpage.js', function: 'runIfPresent', lineno: 59 },
        { filename: 'app:///inpage.js', function: 'run', lineno: 59 },
        ...PATTERN_141DCCA3_FRAMES,
      ],
    }),
    false,
  )
})

test('does NOT suppress an event with a real, non-placeholder message even from chunk 21544', () => {
  // The placeholder is the EXACT literal `"No error message"`; any other
  // non-empty message is a real app error and keeps reporting, even if its
  // frames are the same chunk-21544 shape.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: 'No error message: chunk 21544 failed to load',
      frames: PATTERN_141DCCA3_FRAMES,
    }),
    false,
  )
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({
      message: 'No error',
      frames: PATTERN_141DCCA3_FRAMES,
    }),
    false,
  )
})

test('does NOT suppress a frameless "No error message" event (origin unverifiable)', () => {
  // No frames at all → can't confirm it's our browser chunk; keep reporting.
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({ message: 'No error message', frames: [] }),
    false,
  )
  assert.equal(
    isEmptyMessageUnresolvedBrowserChunkNoise({ message: 'No error message' }),
    false,
  )
})

// Reproduces the Paper Shaders (`@paper-design/shaders-react`) null-WebGL2-
// context crash class — the `getSupportedExtensions` null-context path that
// ESCAPES `<ShaderSafe>` (Better Stack pattern `34127fa4…` + Firefox-wording
// recurrence `dfcb336b…`, call site `new b2` in chunk
// `app:///_next/static/chunks/c76173f0.5ba9c330afa9d53d.js`, prod) plus its
// known sibling `getAttribLocation`. Paper Shaders' shader-mount
// `useEffect`/rAF callback calls a WebGL2 context method on a context that
// became `null` after a context-loss / GPU-blacklist event; the throw is in an
// async callback so the React error boundary can't catch it → global error →
// Sentry → Better Stack. The matcher is the leak-path backstop; the
// `supportsWebGL2()` probe in `shader-safe.tsx` is the primary guard. Covers
// all three JS engine wordings for the same bug: V8
// (`Cannot read properties of null (reading '<m>')`), old JSC
// (`Cannot read property '<m>' of null`), and SpiderMonkey/Firefox
// (`can't access property "<m>"<…>` — the recurrence that shipped through
// PR #4544's V8/JSC-only filter).
const PAPER_SHADER_NULL_CONTEXT_MESSAGES = [
  // V8 (Chrome/Edge).
  "Cannot read properties of null (reading 'getSupportedExtensions')",
  "TypeError: Cannot read properties of null (reading 'getSupportedExtensions')",
  "Unhandled promise rejection: TypeError: Cannot read properties of null (reading 'getSupportedExtensions')",
  "Cannot read properties of null (reading 'getAttribLocation')",
  "TypeError: Cannot read properties of null (reading 'getAttribLocation')",
  "Unhandled promise rejection: Cannot read properties of null (reading 'getAttribLocation')",
  // Old JSC (old Safari/iOS).
  "Cannot read property 'getSupportedExtensions' of null",
  "Cannot read property 'getAttribLocation' of null",
  // SpiderMonkey (Firefox) — the exact recurrence wording from Better Stack
  // pattern `dfcb336b…`: `can't access property "getSupportedExtensions",
  // this.gl is null`. The `, this.gl is null` suffix is library-specific, so
  // the matcher anchors on the stable method-name prefix only.
  'can\'t access property "getSupportedExtensions", this.gl is null',
  'TypeError: can\'t access property "getSupportedExtensions", this.gl is null',
  'Unhandled promise rejection: TypeError: can\'t access property "getSupportedExtensions", this.gl is null',
  'can\'t access property "getAttribLocation", this.gl is null',
  'TypeError: can\'t access property "getAttribLocation", this.gl is null',
  // SpiderMonkey alternate phrasing seen on some Firefox versions
  // (` of <var>. <var> is null` form) — the prefix anchor still matches.
  'can\'t access property "getSupportedExtensions" of this.gl. this.gl is null',
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
  // Covers all three engine wordings (V8, old JSC, SpiderMonkey/Firefox) so
  // the Firefox `can't access property "<m>"` pattern can't swallow a real
  // first-party SpiderMonkey null-deref with a non-WebGL property name.
  const realAppNullDerefMessages = [
    "Cannot read properties of null (reading 'map')",
    "Cannot read properties of null (reading 'length')",
    "TypeError: Cannot read properties of null (reading 'id')",
    "Cannot read property 'foo' of null",
    // A non-null access on getSupportedExtensions (e.g. typo'd as a property
    // of a non-null object) is a different message and must keep reporting.
    "Cannot read properties of undefined (reading 'getSupportedExtensions')",
    // Real first-party SpiderMonkey/Firefox null-deref with an app property
    // name — same SHAPE as the Paper Shaders Firefox message but NOT a WebGL2
    // API method, so it must keep reporting.
    'can\'t access property "map", this.foo is null',
    'TypeError: can\'t access property "id", this.bar is null',
    'can\'t access property "length" of this.baz. this.baz is null',
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

// Reproduces Better Stack error
// 2249441898cd4d7bb679841d57b829b8863c9a4dc1675a88075d794cfd3cd600
// (Kortix Frontend prod, application_id 2346967): 1 occurrence, 0 identified
// users, 2026-07-21 05:08 UTC. A Tampermonkey/Violentmonkey userscript
// (`YoutubeDL.user.js`) `@match`ing `*://*/*` ran on the marketing homepage
// (`https://kortix.com/`, Chrome 150 / Windows 10). The user script's own
// logic called `JSON.parse()` on an `undefined` value, throwing
// `SyntaxError: "undefined" is not valid JSON` as an unhandled promise
// rejection, captured by Sentry's `GlobalHandlers` `onunhandledrejection`.
// The throw's frame is the userscript-manager's synthetic
// `app:///userscript.html?name=YoutubeDL.user.js&id=303c1708-…` wrapper page
// (fn `?`, line 1614) plus a `<anonymous>` `JSON.parse` frame — never
// first-party app code. The `app:///userscript.html` prefix is specific to
// userscript-manager wrappers and never appears on a first-party
// `app:///_next/…` bundle frame or a de-minified `apps/web/src/…` source
// path, so anchoring on it is conservative: a real first-party
// `JSON.parse(undefined)` regression throws inside an app chunk (or a
// de-minified `apps/web/src/…` frame) and is never matched.
const USERSCRIPT_MANAGER_FRAME =
  'app:///userscript.html?name=YoutubeDL.user.js&id=303c1708-e3a7-42b9-bdd1-9c21ea14f6b4'

const USERSCRIPT_MANAGER_FRAMES: Array<{ filename: unknown; function: unknown }> = [
  { filename: USERSCRIPT_MANAGER_FRAME, function: '?' },
  { filename: '<anonymous>', function: 'JSON.parse' },
]

test('classifies the userscript-manager JSON.parse SyntaxError as noise', () => {
  assert.equal(
    isUserscriptManagerNoise({
      message: '"undefined" is not valid JSON',
      frames: USERSCRIPT_MANAGER_FRAMES,
    }),
    true,
  )
})

test('classifies a userscript-manager event from the filename alone (window.onerror)', () => {
  assert.equal(
    isUserscriptManagerNoise({
      message: '"undefined" is not valid JSON',
      filename: USERSCRIPT_MANAGER_FRAME,
    }),
    true,
  )
})

test('classifies userscript-manager frames with different script names/ids as noise', () => {
  // The `app:///userscript.html` prefix is the stable anchor; the script name
  // and id vary per installed user script, so a different script must still
  // classify.
  for (const filename of [
    'app:///userscript.html?name=AdBlockerPro.user.js&id=abc123',
    'app:///userscript.html?name=dark-mode.user.js&id=00000000-0000-0000-0000-000000000000',
    'app:///userscript.html',
  ]) {
    assert.equal(
      isUserscriptManagerNoise({ message: 'anything', filename }),
      true,
      `expected ${filename} to be userscript-manager noise`,
    )
  }
})

test('suppresses the userscript-manager JSON.parse Sentry event', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/' },
      exception: {
        values: [
          {
            type: 'SyntaxError',
            value: '"undefined" is not valid JSON',
            stacktrace: { frames: USERSCRIPT_MANAGER_FRAMES },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the userscript-manager JSON.parse unhandled rejection from the browser (window.onerror)', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Unhandled promise rejection: "undefined" is not valid JSON',
      filename: USERSCRIPT_MANAGER_FRAME,
    }),
    true,
  )
})

test('does NOT suppress a real first-party JSON.parse SyntaxError from app code', () => {
  // A genuine first-party `JSON.parse(undefined)` regression throws the SAME
  // `SyntaxError: "undefined" is not valid JSON` wording but inside an
  // `app:///_next/…` chunk or a de-minified `apps/web/src/…` frame — never from
  // the userscript-manager wrapper. It must keep reporting so the call site can
  // be found + fixed.
  const realAppFrames: Array<{ filename: unknown; function: unknown }> = [
    { filename: 'app:///_next/static/chunks/parse-helpers.js', function: 'parseBody' },
    { filename: 'app:///apps/web/src/lib/api-client.ts', function: 'safeParse' },
    { filename: 'https://app.kortix.com/_next/static/chunks/json.js', function: 'revive' },
  ]
  for (const frames of [realAppFrames, [{ filename: 'apps/web/src/lib/store.ts' }]]) {
    assert.equal(
      isUserscriptManagerNoise({
        message: '"undefined" is not valid JSON',
        frames,
      }),
      false,
      `expected JSON.parse SyntaxError from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://app.kortix.com/projects' },
        exception: {
          values: [
            {
              type: 'SyntaxError',
              value: '"undefined" is not valid JSON',
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting JSON.parse SyntaxError from ${JSON.stringify(frames)}`,
    )
  }
  // And via the runtime gate: a first-party/chunk filename keeps reporting too.
  for (const filename of [
    'app:///_next/static/chunks/json.js',
    'app:///apps/web/src/lib/api-client.ts',
    'https://app.kortix.com/_next/static/chunks/json.js',
  ]) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({
        message: '"undefined" is not valid JSON',
        filename,
      }),
      false,
      `expected runtime gate to keep reporting JSON.parse SyntaxError from ${filename}`,
    )
  }
})

test('does NOT suppress a userscript-shaped event that is NOT from a userscript-manager frame', () => {
  // No userscript-manager frame anchor → can't confirm the throw originated in
  // a user script; keep reporting rather than swallow a possible app bug.
  assert.equal(
    isUserscriptManagerNoise({ message: '"undefined" is not valid JSON' }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [{ value: '"undefined" is not valid JSON' }],
      },
    }),
    false,
  )
})

test('does NOT match the userscript-manager prefix against a first-party _next bundle frame', () => {
  // `app:///_next/static/…` has a single slash after `app:`; the userscript
  // wrapper is `app:///userscript.html` (empty host). They must never collide.
  assert.equal(
    isUserscriptManagerNoise({
      message: 'x',
      filename: 'app:///_next/static/chunks/userscript.html.js',
    }),
    false,
  )
  assert.equal(
    isUserscriptManagerNoise({
      message: 'x',
      frames: [{ filename: 'app:///_next/static/chunks/userscript-helper.js' }],
    }),
    false,
  )
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
// Android System WebView native-bridge `postEvent` noise — the FRAMELESS
// sibling of the `postMessage` class above.
// (Better Stack pattern
//  a6795db236a92a4f9738698e93a8d7ae4e60dae607cacedccb7ed8bbd225b2d4,
//  Kortix Frontend prod, application_id 2346967): the Android Chromium
// WebView's injected `JavaBridge` calls `postEvent` on a Java bridge whose
// backing `JavaObject` has been GC'd (page navigation / WebView teardown /
// in-app browser dismiss) → `Error invoking postEvent: Java object is gone`.
// Unlike the `postMessage` sibling (PR #4610, which carried the synthetic
// `app://navigation_performance_logger_android` frame), this `postEvent`
// variant surfaced as a FRAMELESS capture: call_site_file `<anonymous>`,
// call_site_function `?`, no resolvable stack. So the matcher is anchored on
// BOTH the exact message AND a frameless/injected-WebView origin (no
// resolvable source location, OR the Android nav-perf-logger bridge frame),
// with negative guards preserving any first-party `apps/web/src/…` frame or
// any resolvable real source location so a genuine first-party
// `postEvent`/`dispatchEvent` failure keeps reporting.
// 1 occurrence / 0 identified users, last_seen 2026-07-20 19:05:34 UTC.
// ---------------------------------------------------------------------------

const ANDROID_WEBVIEW_BRIDGE_POSTEVENT_EVENTS = [
  // The exact raw exception value from the production event.
  'Error invoking postEvent: Java object is gone',
  // An unhandled-rejection wrapper preserving the message.
  'Unhandled promise rejection: Error invoking postEvent: Java object is gone',
]

// The frameless capture shape from the production event — no resolvable
// source location, `<anonymous>` / `?` call site.
const FRAMELESS_ANDROID_BRIDGE_FRAMES = [
  { function: '?', filename: 'undefined', lineno: 1 },
]

test('classifies the Android WebView native-bridge postEvent noise (frameless capture)', () => {
  for (const message of ANDROID_WEBVIEW_BRIDGE_POSTEVENT_EVENTS) {
    // Frameless Sentry event — no frames, no filename.
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({ message }),
      true,
      `expected frameless "${message}" to be classified as noise`,
    )
    // Frameless Sentry event — only the synthetic `<anonymous>`/`undefined`
    // placeholder frame (the exact production capture shape).
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({
        message,
        frames: FRAMELESS_ANDROID_BRIDGE_FRAMES,
      }),
      true,
      `expected frameless Sentry event for "${message}" to be classified as noise`,
    )
    // Runtime gate — frameless global-onerror with the synthetic `undefined`
    // filename.
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({
        message,
        filename: 'undefined',
      }),
      true,
      `expected runtime gate frameless "${message}" to be classified as noise`,
    )
  }
})

test('classifies the Android WebView native-bridge postEvent noise (framed sibling — bridge frame)', () => {
  // Forward-compat: if a future occurrence carries the synthetic Android
  // nav-performance-logger bridge frame (the #4610 shape), it is also noise.
  for (const message of ANDROID_WEBVIEW_BRIDGE_POSTEVENT_EVENTS) {
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({
        message,
        frames: [{ filename: ANDROID_NAV_PERF_LOGGER_FRAME }],
      }),
      true,
      `expected framed "${message}" from the Android bridge to be noise`,
    )
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({
        message,
        filename: ANDROID_NAV_PERF_LOGGER_FRAME,
      }),
      true,
      `expected runtime gate to treat "${message}" from the bridge as noise`,
    )
  }
})

test('suppresses the frameless Android WebView postEvent noise via the Sentry beforeSend gate', () => {
  // Frameless Sentry event — no stack frames at all (the exact production
  // capture shape).
  for (const value of ANDROID_WEBVIEW_BRIDGE_POSTEVENT_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://kortix.com/' },
        exception: {
          values: [{ value, stacktrace: { frames: [] } }],
        },
      }),
      true,
      `expected frameless Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses the frameless Android WebView postEvent noise via the runtime (window.onerror) gate', () => {
  for (const message of ANDROID_WEBVIEW_BRIDGE_POSTEVENT_EVENTS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message, filename: 'undefined' }),
      true,
      `expected runtime gate to suppress frameless "${message}"`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message, filename: '' }),
      true,
      `expected runtime gate to suppress "${message}" with empty filename`,
    )
  }
})

test('does NOT suppress a real first-party postEvent/dispatchEvent failure from an app chunk', () => {
  // A genuine `window.postMessage`/`dispatchEvent` failure in our own code
  // could share the message wording but throws from an `app:///_next/…` chunk
  // (or a de-minified `apps/web/src/…` frame) — a resolvable source location
  // — so it must keep reporting so a real regression is never hidden.
  const realAppFrames: Array<{ filename: unknown }> = [
    { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js' },
    { filename: 'apps/web/src/features/messaging/event-bridge.ts' },
  ]
  for (const frames of [
    realAppFrames,
    [{ filename: 'app:///apps/web/src/features/messaging/event-bridge.ts' }],
  ]) {
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({
        message: 'Error invoking postEvent: Java object is gone',
        frames,
      }),
      false,
      `expected real first-party postEvent error from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: 'Error invoking postEvent: Java object is gone',
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting real first-party postEvent error from ${JSON.stringify(frames)}`,
    )
  }
  // And via the runtime gate: a first-party filename keeps reporting.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Error invoking postEvent: Java object is gone',
      filename: 'apps/web/src/features/messaging/event-bridge.ts',
    }),
    false,
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Error invoking postEvent: Java object is gone',
      filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js',
    }),
    false,
  )
})

test('does NOT suppress the postMessage sibling message under the postEvent matcher (and vice versa)', () => {
  // The two matchers are message-specific: a `postMessage` event must not be
  // swallowed by the `postEvent` guard, and a `postEvent` event must not be
  // swallowed by the `postMessage` guard (which would also keep reporting
  // because it has no bridge frame).
  assert.equal(
    isAndroidWebViewNativeBridgePostEventNoise({
      message: 'Error invoking postMessage: Java object is gone',
      frames: [{ filename: ANDROID_NAV_PERF_LOGGER_FRAME }],
    }),
    false,
    'postEvent matcher must not swallow the postMessage message',
  )
  assert.equal(
    isAndroidWebViewNativeBridgePostMessageNoise({
      message: 'Error invoking postEvent: Java object is gone',
      frames: [{ filename: ANDROID_NAV_PERF_LOGGER_FRAME }],
    }),
    false,
    'postMessage matcher must not swallow the postEvent message',
  )
})

test('does NOT suppress a same-worded message from a different bridge / non-Android source with a resolvable frame', () => {
  // A resolvable non-bridge frame (e.g. an iOS sibling filename) keeps
  // reporting — the matcher only suppresses frameless or
  // Android-nav-perf-logger-bridge-originated captures.
  assert.equal(
    isAndroidWebViewNativeBridgePostEventNoise({
      message: 'Error invoking postEvent: Java object is gone',
      frames: [{ filename: 'app://navigation_performance_logger_ios' }],
    }),
    false,
  )
  assert.equal(
    isAndroidWebViewNativeBridgePostEventNoise({
      message: 'Error invoking postEvent: Java object is gone',
      filename: 'app://navigation_performance_logger_androidx',
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


// ---------------------------------------------------------------------------
// @embedpdf/plugin-tiling `TilingLayer` React #185 "Maximum update depth
// exceeded" render-loop noise
// (Better Stack pattern 366115d4c931a6352fe8f334ff1b366f6d4b2ce9c192769ac681831354521e30,
// Kortix Frontend prod, application_id 2346967). The `@embedpdf/plugin-tiling`
// `TilingLayer` React component (used by `pdf-viewer.tsx`'s `<TilingLayer>`)
// subscribes to the tiling plugin's `onTileRendering` event and calls
// `setTiles(...)` on every emission; under a rapid zoom/scroll burst the
// plugin re-emits synchronously during the React commit phase, tripping
// React's 50-nested-update guard (#185). 1 occurrence, 0 identified users,
// 2026-07-15 09:36:41 UTC, route `/projects/:id/sessions/:sessionId`, Chrome
// 142 / Windows 10. The throw frame is `Object.r [as onTileRendering]` in a
// `_next/static/chunks/…` bundle — never first-party `apps/web/src/…` source.
// React #185 is ALSO a real first-party setState-loop message, so the matcher
// requires BOTH the #185 message AND an `onTileRendering` frame, with a
// first-party negative guard.
// ---------------------------------------------------------------------------

// The exact React #185 message from the production event.
const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

// A representative slice of the production stack frames (oldest-first →
// throwing frame last): the React reconciler loop (`uE`/`ux`) recursing
// through the @embedpdf `onTileRendering` callback. All frames are raw
// `_next/static/chunks/…` bundles — none resolve to first-party source.
const EMBEDPDF_TILING_REACT_185_FRAMES = [
  { filename: 'app:///_next/static/chunks/5ccd075d-fe5b6a678bf52bfe.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy', function: 'uE' },
  { filename: 'app:///_next/static/chunks/5ccd075d-fe5b6a678bf52bfe.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy', function: 'ux' },
  { filename: 'app:///_next/static/chunks/5ccd075d-fe5b6a678bf52bfe.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy', function: 'o1' },
  {
    filename: 'app:///_next/static/chunks/78309.4a49d57927d341e9.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy',
    function: 'Object.r [as onTileRendering]',
  },
  { filename: 'app:///_next/static/chunks/5ccd075d-fe5b6a678bf52bfe.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy', function: 't7' },
]

test('classifies the @embedpdf tiling React #185 render loop as noise', () => {
  assert.equal(
    isEmbedPdfTilingReactUpdateDepthNoise({
      message: REACT_185,
      frames: EMBEDPDF_TILING_REACT_185_FRAMES,
    }),
    true,
  )
})

test('suppresses the assigned @embedpdf tiling React #185 Sentry event via the beforeSend gate', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: {
        url: 'https://kortix.com/projects/c4d70885-ce86-4283-b373-bc2fbcd92b85/sessions/917c2468-11bf-4cf0-92e6-20d17fa58e77',
      },
      exception: {
        values: [
          {
            value: REACT_185,
            stacktrace: { frames: EMBEDPDF_TILING_REACT_185_FRAMES },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the @embedpdf tiling React #185 event even with only the onTileRendering frame', () => {
  // A minimal capture carrying just the tiling callback frame still qualifies.
  assert.equal(
    isEmbedPdfTilingReactUpdateDepthNoise({
      message: REACT_185,
      frames: [
        {
          filename: 'app:///_next/static/chunks/78309.4a49d57927d341e9.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy',
          function: 'Object.r [as onTileRendering]',
        },
      ],
    }),
    true,
  )
})

test('does NOT suppress the @embedpdf tiling React #185 when a first-party frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own component is the looping
  // culprit → actionable; the negative guard MUST preserve it so the call site
  // can be found + fixed. This is the whole reason the matcher is frame-aware
  // (React #185 is also a real first-party setState-loop message).
  for (const frames of [
    [{ filename: 'apps/web/src/components/ui/extend/pdf-viewer.tsx', function: 'PDFViewerInner' }],
    [
      { filename: 'app:///_next/static/chunks/78309.4a49d57927d341e9.js', function: 'Object.r [as onTileRendering]' },
      { filename: 'app:///apps/web/src/components/ui/extend/pdf-viewer.tsx', function: 'renderPage' },
    ],
  ]) {
    assert.equal(
      isEmbedPdfTilingReactUpdateDepthNoise({ message: REACT_185, frames }),
      false,
      `expected first-party React #185 from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: REACT_185, stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party React #185 from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress a React #185 with NO onTileRendering frame (a real app or different third-party loop)', () => {
  // A real first-party setState loop, or a #185 from a different third-party
  // lib, carries NO `onTileRendering` frame — it must keep reporting. Only the
  // @embedpdf-tiling #185 class is dropped.
  for (const frames of [
    [{ filename: 'app:///_next/static/chunks/app.js', function: 'useEffect' }],
    [{ filename: 'apps/web/src/features/session/session-chat.tsx', function: 'SessionChat' }],
    [],
  ]) {
    assert.equal(
      isEmbedPdfTilingReactUpdateDepthNoise({ message: REACT_185, frames }),
      false,
      `expected React #185 from ${JSON.stringify(frames)} (no onTileRendering) to keep reporting`,
    )
  }
})

test('does NOT suppress a different React error (#425) even with an onTileRendering frame', () => {
  // The matcher is anchored on the EXACT #185 (Maximum update depth) code; a
  // different React minified error from the tiling plugin is a different,
  // actionable class and must keep reporting.
  assert.equal(
    isEmbedPdfTilingReactUpdateDepthNoise({
      message:
        'Minified React error #425; visit https://react.dev/errors/425 for the full message',
      frames: EMBEDPDF_TILING_REACT_185_FRAMES,
    }),
    false,
  )
})

test('does NOT suppress a non-React message that happens to mention #185', () => {
  // The matcher anchors on `Minified React error #185` — a different message
  // wording must not be matched.
  for (const message of [
    'Maximum update depth exceeded',
    'Error #185 in custom handler',
    'react.dev/errors/185',
  ]) {
    assert.equal(
      isEmbedPdfTilingReactUpdateDepthNoise({
        message,
        frames: EMBEDPDF_TILING_REACT_185_FRAMES,
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
  }
})

// ---------------------------------------------------------------------------
// Firefox-specific React scheduler re-entrancy noise (React #327
// "Should not already be working.", Better Stack pattern
// 0f03b24eb662c20779ea6397c6501f40392a3c9e24ab0f4594ad367eda71b9b7,
// Kortix Frontend prod, application_id 2346967). The React production
// reconciler's `performSyncWorkOnRoot` throws `Error(i(327))` when
// `executionContext & (RenderContext | CommitContext)` is set — i.e. the
// scheduler re-entered while React was already rendering/committing. A
// well-known Firefox-specific scheduler quirk (react-router#10314 / react#17355
// / react#29908) that does NOT reproduce on Chromium/WebKit. 1 occurrence ever
// (90-day window), 0 identified users (anonymous), single release
// `22e12080d2b37642aa92a839da6b37f30fc21b9d`, 2026-07-20 11:53:33 UTC, route
// `/projects/:id/sessions/:sessionId`, Firefox 152.0 on Generic Linux, mechanism
// `auto.browser.global_handlers.onerror` (UNCAUGHT global error). Stack: 2
// frames, BOTH raw React-internal minified production chunks (the React DOM
// reconciler chunk `5ccd075d-…` function `iX` plus the scheduler chunk `66499-…`
// function `x`) — NO first-party `apps/web/src/…` source frame. React #327 is
// ALSO the exact message a real first-party `flushSync`-inside-render or
// sync-setState-during-commit regression would produce, so the matcher requires
// BOTH the canonical `#327;` message AND a NEGATIVE guard: any resolved
// first-party `apps/web/src/…` frame means our own code is the re-entrant
// culprit → keep reporting so the call site can be found + fixed.
// ---------------------------------------------------------------------------

// The exact React #327 message from the production event.
const REACT_327 =
  'Minified React error #327; visit https://react.dev/errors/327 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

// The exact 2-frame production stack (oldest-first → throwing frame last): the
// scheduler continuation `x` in chunk 66499 + the React DOM reconciler `iX`
// (the `ensureRootIsScheduled`/`performConcurrentWorkOnRoot` continuation →
// `iu`/`performSyncWorkOnRoot` which throws `Error(i(327))`). Both frames are
// raw `_next/static/chunks/…` bundles — none resolve to first-party source.
const FIREFOX_REACT_327_FRAMES = [
  { filename: 'app:///_next/static/chunks/66499-30a0e6805d268c02.js?dpl=dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2', function: 'x', in_app: true, lineno: 3, colno: 29932 },
  { filename: 'app:///_next/static/chunks/5ccd075d-fe5b6a678bf52bfe.js?dpl=dpl_BEo2Xvs3YxqRXbFpXiss8RKeu4b2', function: 'iX', in_app: true, lineno: 1, colno: 132934 },
]

test('classifies the Firefox React scheduler re-entrancy (#327) noise', () => {
  assert.equal(
    isFirefoxReactSchedulerReentryNoise({
      message: REACT_327,
      frames: FIREFOX_REACT_327_FRAMES,
    }),
    true,
  )
})

test('suppresses the assigned Firefox React #327 Sentry event via the beforeSend gate', () => {
  // Exact shape of the production event: mechanism
  // `auto.browser.global_handlers.onerror` (uncaught global error), 2 React-
  // internal minified-chunk frames, NO first-party source frame, route
  // `/projects/:id/sessions/:sessionId`.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: {
        url: 'https://kortix.com/projects/3cdc1df5-01e6-492d-b2ab-d81bb8c42fa2/sessions/c102f5de-1b6b-4baf-8cd6-cdd11855330f',
      },
      exception: {
        values: [
          {
            value: REACT_327,
            stacktrace: { frames: FIREFOX_REACT_327_FRAMES },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the Firefox React #327 event even with only the React reconciler chunk frame', () => {
  // A minimal capture carrying just the React DOM reconciler `iX` frame (the
  // throwing frame Better Stack surfaces as the call site) still qualifies —
  // it is the React-internal minified-chunk anchor that matters.
  assert.equal(
    isFirefoxReactSchedulerReentryNoise({
      message: REACT_327,
      frames: [FIREFOX_REACT_327_FRAMES[1]],
    }),
    true,
  )
})

test('suppresses the Firefox React #327 event with a chunk filename that has no dpl query', () => {
  // Different Vercel deployment / cached chunk: the frame is still a React
  // minified production chunk (`_next/static/chunks/…`) with no first-party
  // source path, so it still classifies. The `dpl=dpl_…` query is not load-
  // bearing for the matcher — `isBrowserBundleSource` matches the path prefix.
  assert.equal(
    isFirefoxReactSchedulerReentryNoise({
      message: REACT_327,
      frames: [
        { filename: 'app:///_next/static/chunks/5ccd075d-fe5b6a678bf52bfe.js', function: 'iX' },
      ],
    }),
    true,
  )
})

test('does NOT suppress the Firefox React #327 when a first-party frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code IS the re-entrant
  // culprit (e.g. a real `flushSync` inside a render phase, or a sync
  // `setState` during commit) → actionable; the negative guard MUST preserve
  // it so the call site can be found + fixed. This is the whole reason the
  // matcher is frame-aware (React #327 is also a real first-party re-entrancy
  // message — see `pdf-viewer.tsx:2101` for the only first-party `flushSync`
  // call site, which would surface this way if it ever regresses).
  for (const frames of [
    [{ filename: 'apps/web/src/features/file-renderers/pdf/pdf-viewer.tsx', function: 'rotatePage' }],
    [
      { filename: 'app:///_next/static/chunks/5ccd075d-fe5b6a678bf52bfe.js', function: 'iX' },
      { filename: 'app:///apps/web/src/features/session/session-chat.tsx', function: 'SessionChat' },
    ],
  ]) {
    assert.equal(
      isFirefoxReactSchedulerReentryNoise({ message: REACT_327, frames }),
      false,
      `expected first-party React #327 from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: REACT_327, stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party React #327 from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress a React #327 with NO browser-bundle frame (a real app or different-third-party throw)', () => {
  // A real first-party `throw new Error('Should not already be working.')` in
  // app code (NOT via React's minified-error-#327 path) — or a #327 from a
  // third-party lib whose frames don't resolve to our bundle — carries NO
  // React-internal chunk frame, so the React-internal anchor is missing. Keep
  // reporting rather than blanket-dropping events of unknown origin.
  for (const frames of [
    [{ filename: 'apps/web/src/features/co-worker/foo.tsx', function: 'bar' }],
    [{ filename: 'https://cdn.example.com/some-lib.js', function: 'f' }],
    [],
  ]) {
    assert.equal(
      isFirefoxReactSchedulerReentryNoise({ message: REACT_327, frames }),
      false,
      `expected React #327 from ${JSON.stringify(frames)} (no React-internal chunk frame) to keep reporting`,
    )
  }
})

test('does NOT suppress a different React error (#185) even with the same React chunk frames', () => {
  // The matcher anchors on the EXACT #327 (re-entrancy guard) code; a
  // different React minified error from the same React chunk is a different,
  // actionable class and must keep reporting. (The sibling @embedpdf #185
  // classifier handles its own #185 noise class.)
  assert.equal(
    isFirefoxReactSchedulerReentryNoise({
      message:
        'Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.',
      frames: FIREFOX_REACT_327_FRAMES,
    }),
    false,
  )
})

test('does NOT suppress a non-React message that happens to mention #327', () => {
  // The matcher anchors on `Minified React error #327;` — a different message
  // wording must not be matched.
  for (const message of [
    'Should not already be working.',
    'Error #327 in custom handler',
    'react.dev/errors/327',
    'Unhandled promise rejection: Should not already be working.',
  ]) {
    assert.equal(
      isFirefoxReactSchedulerReentryNoise({
        message,
        frames: FIREFOX_REACT_327_FRAMES,
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a bare `Should not already be working.` thrown from first-party app code', () => {
  // A real first-party `throw new Error('Should not already be working.')` is
  // NOT a React-minified-error-#327 capture (no `Minified React error #327;`
  // prefix), so it never matches the React-internal noise class and keeps
  // reporting — even if its frame happens to be a chunk frame. The matcher is
  // anchored on React's canonical minified-error wording, not the bare
  // message text, so app-code throws of the same string never get swallowed.
  assert.equal(
    isFirefoxReactSchedulerReentryNoise({
      message: 'Should not already be working.',
      frames: FIREFOX_REACT_327_FRAMES,
    }),
    false,
  )
})

// ---------------------------------------------------------------------------
// Browser-extension EIP-1193 wallet-provider plain-object rejection noise
// (Better Stack pattern
// 0f78b2f8e9efa79fe9b2ea534e275c704f113eafea86bae5470f33174ebacebc,
// Kortix Frontend prod, application_id 2346967, `UnhandledRejection`). A
// wallet extension (extension id `lgmpcpglpngdoalbgeoldeajfclnhafa`) injects
// an EIP-1193 provider whose content script
// (`chrome-extension://<id>/content-script.js`) rejects pending JSON-RPC
// requests with a PLAIN OBJECT — not an Error — of shape
// `{ code: 4900, message: "The provider is disconnected from all chains.",
// stack: "Error: …\\n    at … (chrome-extension://…/content-script.js)" }`
// (EIP-1193 code 4900 = "provider is disconnected"). Because the rejected
// value is not an Error, Sentry's GlobalHandlers `onunhandledrejection`
// integration cannot extract a stack: it serializes the object's enumerable
// keys into `extra.__serialized__` and sets the exception value to the
// synthetic "Object captured as promise rejection with keys: code, message,
// stack" with NO stacktrace frames. The extension origin therefore lives
// ONLY in `extra.__serialized__.stack` — the frame-aware extension guards
// (`isExtensionSource`, `isInpageWalletStreamNoise`, `isTronLinkProxyNoise`)
// all miss it (no frames to anchor on). 2 occurrences, 0 identified users,
// first 2026-07-06 / last 2026-07-15, mechanism
// `auto.browser.global_handlers.onunhandledrejection`, request URL
// `https://kortix.com/auth`, Chrome 150. The matcher requires BOTH the
// synthetic signature AND an extension-origin frame inside the serialized
// stack so a real first-party `Promise.reject({...})` keeps reporting.
// ---------------------------------------------------------------------------

// The exact serialized rejection payload from the raw production event.
const EIP1193_PROVIDER_DISCONNECTED_SERIALIZED = {
  message: 'The provider is disconnected from all chains.',
  stack:
    'Error: The provider is disconnected from all chains.\n' +
    '    at s (chrome-extension://lgmpcpglpngdoalbgeoldeajfclnhafa/content-script.js:13:100356)\n' +
    '    at Object.disconnected (chrome-extension://lgmpcpglpngdoalbgeoldeajfclnhafa/content-script.js:13:101769)\n' +
    '    at chrome-extension://lgmpcpglpngdoalbgeoldeajfclnhafa/content-script.js:26:51970\n' +
    '    at E.rejectWaitingRequests (chrome-extension://lgmpcpglpngdoalbgeoldeajfclnhafa/content-script.js:26:51985)\n' +
    '    at chrome-extension://lgmpcpglpngdoalbgeoldeajfclnhafa/content-script.js:26:59539',
  code: 4900,
}

const SYNTHETIC_OBJECT_REJECTION_VALUE =
  'Object captured as promise rejection with keys: code, message, stack'

test('classifies the EIP-1193 provider-disconnected plain-object rejection as noise', () => {
  assert.equal(
    isExtensionRejectedObjectNoise({
      message: SYNTHETIC_OBJECT_REJECTION_VALUE,
      extra: { __serialized__: EIP1193_PROVIDER_DISCONNECTED_SERIALIZED },
    }),
    true,
  )
})

test('suppresses the assigned Sentry event via the beforeSend gate (frameless synthetic capture)', () => {
  // Exact shape of the production event: synthetic exception value, NO
  // stacktrace frames, extension origin only in extra.__serialized__.stack.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/auth' },
      extra: { __serialized__: EIP1193_PROVIDER_DISCONNECTED_SERIALIZED },
      exception: {
        values: [{ value: SYNTHETIC_OBJECT_REJECTION_VALUE }],
      },
    }),
    true,
  )
})

test('suppresses the Firefox (moz-extension://) wallet variant', () => {
  assert.equal(
    isExtensionRejectedObjectNoise({
      message: SYNTHETIC_OBJECT_REJECTION_VALUE,
      extra: {
        __serialized__: {
          message: 'The provider is disconnected from all chains.',
          stack: 'Error: The provider is disconnected from all chains.\n    at Object.disconnected (moz-extension://abcdef/content-script.js:1:1)',
          code: 4900,
        },
      },
    }),
    true,
  )
  assert.equal(
    isExtensionRejectedObjectNoise({
      message: SYNTHETIC_OBJECT_REJECTION_VALUE,
      extra: {
        __serialized__: {
          message: 'foo',
          stack: 'Error: foo\n    at x (safari-web-extension://com.example.ext/content.js:1:1)',
          code: 1,
        },
      },
    }),
    true,
  )
})

test('suppresses the wallet-provider rejection via the runtime (unhandledrejection) gate', () => {
  // The runtime gate receives the raw rejected object as `reason`; its
  // `message` is the provider's own ("The provider is disconnected…"), NOT
  // Sentry's synthetic wording, so the gate anchors on the rejected value's
  // own `stack` tracing through the extension content script.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({ reason: EIP1193_PROVIDER_DISCONNECTED_SERIALIZED }),
    true,
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({ error: EIP1193_PROVIDER_DISCONNECTED_SERIALIZED }),
    true,
  )
})

test('does NOT suppress a synthetic plain-object rejection with NO serialized payload (conservative — keep reporting)', () => {
  // No `extra.__serialized__` to confirm extension origin → a first-party
  // `Promise.reject({code, message, stack})` could produce the same synthetic
  // signature, so keep reporting.
  assert.equal(
    isExtensionRejectedObjectNoise({ message: SYNTHETIC_OBJECT_REJECTION_VALUE }),
    false,
  )
  assert.equal(
    isExtensionRejectedObjectNoise({
      message: SYNTHETIC_OBJECT_REJECTION_VALUE,
      extra: {},
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: { values: [{ value: SYNTHETIC_OBJECT_REJECTION_VALUE }] },
    }),
    false,
  )
})

test('does NOT suppress a synthetic plain-object rejection whose serialized stack has NO extension origin', () => {
  // The serialized stack traces through our own app chunk, not an extension
  // content script → a real first-party plain-object rejection; keep reporting.
  assert.equal(
    isExtensionRejectedObjectNoise({
      message: SYNTHETIC_OBJECT_REJECTION_VALUE,
      extra: {
        __serialized__: {
          message: 'boom',
          stack: 'Error: boom\n    at handleClick (app:///_next/static/chunks/app.js:42:10)',
          code: 500,
        },
      },
    }),
    false,
  )
})

test('does NOT suppress a synthetic plain-object rejection whose stacktrace resolves to a first-party frame', () => {
  // Negative guard: a resolved `apps/web/src/…` frame means our own code
  // rejected the plain object — actionable, keep reporting.
  assert.equal(
    isExtensionRejectedObjectNoise({
      message: SYNTHETIC_OBJECT_REJECTION_VALUE,
      extra: { __serialized__: EIP1193_PROVIDER_DISCONNECTED_SERIALIZED },
      frames: [{ filename: 'apps/web/src/lib/wallet-provider.ts' }],
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      extra: { __serialized__: EIP1193_PROVIDER_DISCONNECTED_SERIALIZED },
      exception: {
        values: [
          {
            value: SYNTHETIC_OBJECT_REJECTION_VALUE,
            stacktrace: {
              frames: [{ filename: 'app:///apps/web/src/lib/wallet-provider.ts' }],
            },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress a real Error rejection (not the synthetic plain-object signature)', () => {
  // A genuine rejected Error carries a real message and stacktrace, never the
  // synthetic "Object captured as promise rejection with keys: …" wording.
  for (const value of [
    'The provider is disconnected from all chains.',
    'TypeError: Cannot read properties of undefined (reading id)',
    'Internal server error',
  ]) {
    assert.equal(
      isExtensionRejectedObjectNoise({
        message: value,
        extra: { __serialized__: EIP1193_PROVIDER_DISCONNECTED_SERIALIZED },
      }),
      false,
      `expected real error "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        extra: { __serialized__: EIP1193_PROVIDER_DISCONNECTED_SERIALIZED },
        exception: { values: [{ value }] },
      }),
      false,
      `expected real Sentry event "${value}" to keep reporting`,
    )
  }
})

test('does NOT suppress a runtime rejection whose reason is a real Error with an app-only stack', () => {
  // A real Error from app code has a stack of app/chunk frames, never an
  // extension content-script frame → keep reporting.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      reason: {
        message: 'something failed',
        stack: 'Error: something failed\n    at handleClick (app:///_next/static/chunks/app.js:42:10)',
      },
    }),
    false,
  )
})

// ---------------------------------------------------------------------------
// Sentry 10.x bare-`undefined` non-Error promise rejection noise
// (Better Stack pattern
// 5cfc90e5077a4f3d956f46b51beb633256b9a74532717d4b5797ca5cbc62f2f1,
// Kortix Frontend prod, application_id 2346967, `UnhandledRejection`). A
// promise rejected with the primitive `undefined` (NOT an Error instance),
// captured by Sentry's GlobalHandlers `onunhandledrejection` integration as
// the synthetic "Non-Error promise rejection captured with value: undefined"
// message with NO stacktrace frames at all (there is no stack to de-minify —
// the rejection carries none). The breadcrumbs around the production event
// are all third-party fetches on the marketing site (`/api/github-stars`,
// `/_vercel/insights/view`, `cdn-cookieyes.com`, `/api/maintenance`) plus the
// recurring `Unsupported color format var(--kortix-orange)` console.error — a
// third-party/cookie-library runtime, not first-party app code. 1 occurrence,
// 0 identified users (anonymous), mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT global
// unhandledrejection — never reached a React error boundary), release
// `470fe6f3c88460212c3b187f6f86fb4ad456c4d6`, first 2026-04-23 / last
// 2026-07-22, Safari 26.5.2 on iOS 18.7 (iPhone, Mobile), request URL
// `https://kortix.com/` (the marketing/landing page). Stack trace: NONE —
// `call_site_file`/`call_site_function` are null, `call_stack_hash` is null,
// no frames at all.
//
// DISTINCT from the EIP-1193 wallet-extension plain-object rejection class
// (`isExtensionRejectedObjectNoise` / Better Stack `0f78b2f8…`, PR #4720):
// that one rejects with a serialized OBJECT (`{ code, message, stack }`) and
// Sentry emits "Object captured as promise rejection with keys: …" (carrying
// the extension stack in `extra.__serialized__.stack`). THIS class rejects
// with the primitive `undefined` and Sentry emits
// "Non-Error promise rejection captured with value: undefined" with no
// serialized payload and no frames. The two message prefixes are disjoint, so
// the matchers do not shadow each other.
//
// The "Non-Error promise rejection captured with value: undefined" message is
// Sentry's generic signature for ANY `Promise.reject(undefined)` — a real
// first-party `Promise.reject(undefined)` would produce the SAME signature —
// so the matcher requires the canonical message AND NEGATIVE guards: if the
// event has ANY resolved stack frame OR a resolved first-party
// `apps/web/src/…` frame, keep reporting (a real first-party
// `Promise.reject(undefined)` we can attribute should still surface). The
// production noise pattern has NO frames at all; only the frameless capture
// is dropped.
// ---------------------------------------------------------------------------

// The exact synthetic message from the production event.
const NON_ERROR_UNDEFINED_REJECTION =
  'Non-Error promise rejection captured with value: undefined'

test('classifies the bare-undefined non-Error promise rejection noise', () => {
  // Exact production shape: the canonical message, NO frames (the rejection
  // carried no stack).
  assert.equal(
    isNonErrorUndefinedRejectionNoise({
      message: NON_ERROR_UNDEFINED_REJECTION,
      frames: [],
    }),
    true,
  )
})

test('suppresses the assigned bare-undefined rejection Sentry event via the beforeSend gate', () => {
  // Exact shape of the production event: type `UnhandledRejection`, mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (uncaught global
  // unhandledrejection — never reached a React error boundary), NO
  // stacktrace frames, request URL `https://kortix.com/` (marketing site).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/' },
      exception: {
        values: [
          {
            value: NON_ERROR_UNDEFINED_REJECTION,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the bare-undefined rejection when frames are absent entirely (no stacktrace key)', () => {
  // The production event has no frames at all — Sentry omits the stacktrace
  // key entirely when there is nothing to serialize. The gate must still drop
  // it (frames default to []).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://kortix.com/' },
      exception: {
        values: [{ value: NON_ERROR_UNDEFINED_REJECTION }],
      },
    }),
    true,
  )
})

test('does NOT suppress a non-undefined non-Error rejection (e.g. an object or string value)', () => {
  // A rejection with a non-undefined value produces a DIFFERENT synthetic
  // message ("…with value: [object Object]" / "…with value: some string") —
  // that is the EIP-1193 plain-object class handled separately by
  // `isExtensionRejectedObjectNoise` (PR #4720). THIS matcher must not shadow
  // it: the canonical-`undefined` anchor is exact, so any other value keeps
  // reporting.
  for (const message of [
    'Non-Error promise rejection captured with value: [object Object]',
    'Non-Error promise rejection captured with value: some string',
    'Non-Error promise rejection captured with value: null',
    'Non-Error promise rejection captured with value: 0',
    'Object captured as promise rejection with keys: code, message, stack',
  ]) {
    assert.equal(
      isNonErrorUndefinedRejectionNoise({
        message,
        frames: [],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: message, stacktrace: { frames: [] } }],
        },
      }),
      false,
      `expected Sentry event "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress the bare-undefined rejection when a first-party frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code rejected a promise
  // with `undefined` → actionable; the negative guard MUST preserve it so the
  // call site can be found + fixed. This is the whole reason the matcher is
  // frame-aware (the message is also a real first-party
  // `Promise.reject(undefined)` signature).
  for (const frames of [
    [{ filename: 'apps/web/src/features/workspace/customize/index.ts', function: 'loadConfig' }],
    [
      { filename: 'app:///_next/static/chunks/main.js', function: 'f' },
      { filename: 'app:///apps/web/src/lib/api/client.ts', function: 'fetchProject' },
    ],
  ]) {
    assert.equal(
      isNonErrorUndefinedRejectionNoise({
        message: NON_ERROR_UNDEFINED_REJECTION,
        frames,
      }),
      false,
      `expected first-party bare-undefined rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: NON_ERROR_UNDEFINED_REJECTION, stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party bare-undefined rejection from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress the bare-undefined rejection when any resolvable (non-first-party) frame is present', () => {
  // Any resolvable source location (real chunk / URL / named file) means the
  // rejection is attributable — a real first-party or third-party
  // `Promise.reject(undefined)` with a stack we can trace. Keep reporting;
  // only the frameless capture (the production noise pattern) is dropped.
  for (const frames of [
    [{ filename: 'app:///_next/static/chunks/123-abc.js', function: 'x' }],
    [{ filename: 'https://cdn.cookieyes.com/cookieyes.js', function: 'init' }],
    [{ filename: 'app:///inpage.js', function: 'emit' }],
  ]) {
    assert.equal(
      isNonErrorUndefinedRejectionNoise({
        message: NON_ERROR_UNDEFINED_REJECTION,
        frames,
      }),
      false,
      `expected attributable bare-undefined rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
  }
})

test('does NOT suppress a message that only mentions the non-Error rejection wording', () => {
  // The matcher anchors on the EXACT canonical message; a different wording
  // that merely mentions the prefix must not be matched.
  for (const message of [
    'Non-Error promise rejection captured with value: undefined (extra context)',
    'Non-Error promise rejection',
    'promise rejection captured with value: undefined',
    'UnhandledRejection: undefined',
  ]) {
    assert.equal(
      isNonErrorUndefinedRejectionNoise({
        message,
        frames: [],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
  }
})
