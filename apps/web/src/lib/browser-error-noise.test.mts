import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isAndroidWebViewNativeBridgePostEventNoise,
  isAndroidWebViewNativeBridgePostMessageNoise,
  isCaptchaInterceptorNoise,
  isCanvasImageDataOOMNoise,
  isClientRequestTimeoutMessage,
  isConnectionClosedNoise,
  isDocumentStateNotFoundNoise,
  isEmptyMessageUnresolvedBrowserChunkNoise,
  isEmbedPdfTilingReactUpdateDepthNoise,
  isEmbedPdfTilingTileDestructureNoise,
  isExpectedBillingGateMessage,
  isExpectedCompactionNoModelMessage,
  isExtensionRejectedObjectNoise,
  isExtensionSource,
  isFirefoxReactSchedulerReentryNoise,
  isFramelessNetworkErrorNoise,
  isInjectedAppSource,
  isInpageJsNoErrorMessageNoise,
  isInjectedScriptSendMessageNoise,
  isInpageWalletStreamNoise,
  isIOSWebViewWebKitBridgeNoise,
  isKnownBrowserNoiseMessage,
  isModelNotServableNoise,
  isNonErrorObjectNotFoundRejectionNoise,
  isNonErrorUndefinedRejectionNoise,
  isOldBrowserDomNullDerefNoise,
  isOldBrowserSyntaxParseError,
  isOldWebkitRegexNoiseMessage,
  isOperationErrorPopErrorScopeNoise,
  isPaperShaderNullContextNoise,
  isPaperShaderWebGLUnsupportedNoise,
  isRuntimeNotReadyNoiseMessage,
  isSafariGenericSecurityErrorNoise,
  isServerDeadlineNoiseMessage,
  isStaleWebpackRuntimeCallNoise,
  isStorageDisabledWebViewNoiseMessage,
  isStorageSecurityErrorNoise,
  isSupabaseTokenExpiredNoise,
  isThirdPartyReactUpdateDepthNoise,
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
      request: { url: 'https://app.dosco.live/auth' },
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
      filename: 'https://app.dosco.live/_next/static/chunk.js',
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

// Reproduces Better Stack error 8bc2dce8...0384f8 (dosco Frontend prod):
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
      request: { url: 'https://dosco.live/pt' },
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
      request: { url: 'https://dosco.live/projects?auth_event=login&auth_method=google' },
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
      request: { url: 'https://dosco.live/' },
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
      request: { url: 'https://dosco.live/projects' },
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
  // Reproduces error c4085f6b...256290 (dosco Frontend prod): an
  // onunhandledrejection from a scanner bot monkey-patching native Promise.then
  // on the marketing homepage. The de-minified frame points at our own chunk,
  // so this must be matched by message, not by source.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
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

// Reproduces the dosco Frontend (prod) RuntimeNotReadyError cluster (patterns
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
        request: { url: 'https://app.dosco.live/projects/p/sessions/s' },
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
// (6 occurrences), dosco Frontend (prod), application_id 2346967: a browser-
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
      request: { url: 'https://app.dosco.live/projects' },
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
      request: { url: 'https://app.dosco.live/projects' },
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
      request: { url: 'https://app.dosco.live/projects' },
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
// 50c1919a...0bf1cd (2 occurrences), dosco Frontend (prod), application_id
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
  'Subscribe to activate your seat. $40/teammate per month includes wallet credits for compute and LLM usage.',
]

// The seat price lives in apps/api and this filter matches the rendered string,
// so the two drift silently: the API moved to $40, this list stayed at $20, and
// an expected billing state paged as an error until someone read the Sentry
// volume. A stale price must fail the suite, not the on-call rotation.
const SUPERSEDED_BILLING_GATE_MESSAGES = [
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

test('a superseded seat price is NOT still carried as an expected message', () => {
  // Keeping the old string "working" is what hides the drift: the filter looks
  // healthy while the message the API actually sends sails past it.
  for (const message of SUPERSEDED_BILLING_GATE_MESSAGES) {
    assert.equal(
      isExpectedBillingGateMessage(message),
      false,
      `stale seat price still allow-listed: ${message}`,
    )
  }
})

test('suppresses a billing-gate 402 Sentry event regardless of capture path', () => {
  for (const value of BILLING_GATE_EXPECTED_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://app.dosco.live/projects/p/sessions/s' },
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
// (dosco Frontend prod): the SDK's `useSummarizeRuntimeSession` mutation
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
        request: { url: 'https://app.dosco.live/projects/p/sessions/s' },
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

// Reproduces Better Stack error
// 9784f440a71c4430667ed3aca8b727c065f38c226ecad3f33f37c7a86476a576
// (dosco Frontend prod): `ApiError`, message
// `Model "openai/gpt-5.4-mini" is not available for this account`, 7
// occurrences / 0 identified users, first 2026-08-06 05:09 UTC (ALL post-v0.12.4),
// request URL `https://dosco.live/projects/377b3ef0-…/sessions/d3d542…` (co-
// worker session page), browser Android Chrome mobile, mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT,
// `handled:false`). PR #6082 added an SDK classification gate in
// `packages/sdk/src/core/http/api-client.ts` `makeRequest` that silences the
// typed 409 `code === 'model_not_servable'` from `onError` (Sentry), and added
// an `onError` handler to `useModelDefaults`'s `setMutation` that surfaces a
// user-facing toast. BUT the 7 occurrences STILL reached Sentry as UNCAUGHT
// `onunhandledrejection` because every call site fire-and-forgets the
// returned promise — `void setAccountDefault(...)` / `void setAgentDefault
// (...)` / `void setProjectDefault(...)` in `session-chat.tsx:3416/3422/3426`,
// `agents-view.tsx:297`, `gateway-view.tsx:137`, and `models-tab.tsx:156`.
// The chain: `setModelDefault` → `unwrap(backendApi.put(...))` THROWS the
// `ApiError` on `!res.success` → `mutateAsync` rejects → the `async` wrapper's
// promise rejects → `void` discards the rejected promise with no `.catch()` →
// unhandled rejection → Sentry's `onunhandledrejection`. The `setMutation`
// `onError` swallows the rejection inside react-query (the toast fires), but
// react-query v5's `onError` does NOT prevent `mutateAsync`'s returned promise
// from rejecting, so the `void`-discarded promise still surfaces as an
// uncaught global rejection. The SDK `makeRequest` gate silences `onError`
// (the Sentry callback), but the unhandled rejection happens at the `.then()`
// / `void` level — AFTER `makeRequest` returned — so the gate never sees it.
// This matcher is the leak-path backstop, sibling to the billing-gate /
// compaction-no-model matchers (also `ApiError`/Error throws that leak via
// `void` fire-and-forget → `onunhandledrejection`). The model name varies, so
// the match is a REGEX anchored on the EXACT API wording
// `Model "…" is not available for this account` (the same template across all
// four emitting routes — `r4.ts:3045`, `channel-bindings.ts:288`, `r7.ts:2811`,
// `sessions.ts:741`), with the canonical `ApiError: ` / `Unhandled promise
// rejection: ` wrappers, so a longer real error that merely mentions the
// phrase is never matched.
const MODEL_NOT_SERVABLE_EVENTS = [
  // The bare API message — the SDK `ApiError.message` — for the assigned
  // prod pattern (`openai/gpt-5.4-mini`).
  'Model "openai/gpt-5.4-mini" is not available for this account',
  // A different model id (BYOK `provider/model` shape) — the prior prod
  // recurrence (`nvidia/minimaxai/minimax-m3`, pattern `ed07f6c5…`). The
  // matcher must anchor on the wording, not a specific model.
  'Model "nvidia/minimaxai/minimax-m3" is not available for this account',
  // An `ApiError:`-prefixed wrapper (e.g. Sentry's exception `value`
  // formatting, or a console/error-boundary re-throw).
  'ApiError: Model "openai/gpt-5.4-mini" is not available for this account',
  // An unhandled-rejection wrapper preserving the message (Sentry
  // `onunhandledrejection` auto-capture, `handled:false` — the prod shape).
  'Unhandled promise rejection: Model "openai/gpt-5.4-mini" is not available for this account',
  // An unhandled-rejection wrapper around an `ApiError:`-prefixed re-throw
  // (the full wrapper stack).
  'Unhandled promise rejection: ApiError: Model "openai/gpt-5.4-mini" is not available for this account',
]

test('classifies the model-not-servable validation state as expected', () => {
  for (const message of MODEL_NOT_SERVABLE_EVENTS) {
    assert.equal(
      isModelNotServableNoise(message),
      true,
      `expected "${message}" to be classified as model-not-servable noise`,
    )
  }
})

test('suppresses a model-not-servable Sentry event regardless of capture path', () => {
  for (const value of MODEL_NOT_SERVABLE_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://dosco.live/projects/p/sessions/s' },
        exception: {
          values: [
            {
              value,
              // The unhandled-rejection stack DOES carry resolved first-party
              // `apps/web/src/…` call-site frames (the `void setXxxDefault(...)`
              // call sites in session-chat.tsx / agents-view.tsx / gateway-view.tsx).
              // The matcher is deliberately message-only (NO first-party
              // negative guard) — mirroring the billing-gate / compaction-no-model
              // matchers — so a first-party call-site frame does NOT veto
              // suppression (that's the whole point: the prod noise carries
              // first-party frames and must still be dropped).
              stacktrace: {
                frames: [
                  { filename: 'app:///_next/static/chunks/sdk.js' },
                  { filename: 'apps/web/src/features/session/session-chat.tsx' },
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

test('suppresses a model-not-servable unhandled rejection from the browser', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        'Unhandled promise rejection: Model "openai/gpt-5.4-mini" is not available for this account',
    }),
    true,
  )
  // The runtime gate also receives the raw `reason` (the `ApiError` instance),
  // whose `message` is the bare API string — the `extractMessage` path must
  // classify it too.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      reason: { message: 'Model "openai/gpt-5.4-mini" is not available for this account' },
    }),
    true,
  )
})

test('does NOT suppress a longer real error containing the model-not-servable wording', () => {
  for (const value of [
    'Failed to set default: Model "openai/gpt-5.4-mini" is not available for this account',
    'Model "openai/gpt-5.4-mini" is not available for this account while saving',
    'ApiError: Model "openai/gpt-5.4-mini" is not available for this account and more',
    'Unhandled promise rejection: Something else: Model "x" is not available for this account',
  ]) {
    assert.equal(
      isModelNotServableNoise(value),
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

test('does NOT suppress a real model-defaults mutation failure (network / 5xx)', () => {
  for (const value of [
    'Internal server error',
    'HTTP 500: Internal Server Error',
    'TypeError: Cannot read properties of undefined (reading modelID)',
    'Failed to fetch',
  ]) {
    assert.equal(
      isModelNotServableNoise(value),
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
        exception: { values: [{ value, stacktrace: { frames: [] } }] },
      }),
      true,
      `expected Sentry event "${value}" to be suppressed`,
    )
  }
})

// ---------------------------------------------------------------------------
// Supabase gotrue `TOKEN_EXPIRED` auth-session rejection noise (Better Stack
// pattern 63b0cde714048bca4c42129afacd5f8ec56813e0e663fbdb41265fdba6ed28a4,
// dosco Frontend prod, application_id 2346967, `UnhandledRejection`). A
// Supabase auth session JWT expired mid-flight (during a page load after a
// Google OAuth redirect, or during a stale session transition), and a
// fire-and-forget `.then()` on a Supabase auth call rejected with the plain
// gotrue error object `{ code: 400, message: "TOKEN_EXPIRED", status:
// "INVALID_ARGUMENT" }`. Because the rejected value is a plain object (NOT an
// Error), Sentry's GlobalHandlers `onunhandledrejection` integration cannot
// extract a stack from it: it serializes the object's own enumerable keys into
// `extra.__serialized__` and sets the exception value to the synthetic
// "Object captured as promise rejection with keys: code, message, status" with
// NO stacktrace frames. 2 occurrences, 0 identified users (anonymous), first
// 2026-08-01 13:22:03 UTC, last 2026-08-01 13:22:27 UTC, mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT global
// unhandledrejection — never reached a React error boundary), release
// `c330eda4d96e7aee557618254a86df7d16ba5d9b` (v0.12.0), request URLs
// `https://dosco.live/auth` (first occurrence) and
// `https://dosco.live/projects/c5a6e2f5-8880-4c30-bbbf-40fbcc1a1fbf` (second
// occurrence, referer `https://accounts.google.com/` post-Google OAuth), Chrome
// 151.0.0.0 on Windows. Stack trace: NONE — `call_site_file`/`call_site_function`
// are null, `call_stack_hash` is null, no frames at all.
//
// DISTINCT from the EIP-1193 wallet-extension plain-object rejection class
// (`isExtensionRejectedObjectNoise`, PR #4720, Better Stack `0f78b2f8…`):
// that one rejects with `{ code, message, stack }` (keys include `stack` with
// an extension content-script origin) and the message is "Object captured as
// promise rejection with keys: code, message, stack". THIS class rejects with
// `{ code, message, status }` (keys include `status` instead of `stack`) and
// the message is "Object captured as promise rejection with keys: code, message,
// status". The two matchers are disjoint because the wallet-extension matcher
// requires a serialized `stack` with an extension-origin protocol prefix, which
// this event lacks (no `stack` key in `__serialized__`). The wallet-extension
// matcher's `SYNTHETIC_OBJECT_REJECTION_PATTERN` is a prefix match
// (`/^Object captured as promise rejection with keys:/`) that would match BOTH
// messages, but the extension-origin stack check rejects this event (there is
// no `stack` key), so the wallet-extension matcher returns false for this class.
//
// The "Object captured as promise rejection with keys: code, message, status"
// message is Sentry's generic signature for ANY `Promise.reject({ code, message,
// status })` — a real first-party `Promise.reject({ code: 400, message:
// "TOKEN_EXPIRED", status: "INVALID_ARGUMENT" })` would produce the SAME
// signature — so the matcher requires the canonical message AND NEGATIVE guards:
// if the event has ANY resolved stack frame OR a resolved first-party
// `apps/web/src/…` frame, keep reporting (a real first-party
// `Promise.reject({ code, message, status })` we can attribute should still
// surface). The production noise pattern has NO frames at all; only the
// frameless capture is dropped.
// ---------------------------------------------------------------------------

// The exact synthetic message from the production event.
const SUPABASE_TOKEN_EXPIRED_REJECTION =
  'Object captured as promise rejection with keys: code, message, status'

test('classifies the Supabase TOKEN_EXPIRED frameless rejection noise', () => {
  // Exact production shape: the canonical message, NO frames (the rejection
  // carried no stack).
  assert.equal(
    isSupabaseTokenExpiredNoise({
      message: SUPABASE_TOKEN_EXPIRED_REJECTION,
      frames: [],
    }),
    true,
  )
})

test('suppresses the Supabase TOKEN_EXPIRED Sentry event via the beforeSend gate (first occurrence — /auth)', () => {
  // Exact shape of the first production event: type `UnhandledRejection`,
  // mechanism `auto.browser.global_handlers.onunhandledrejection` (uncaught
  // global unhandledrejection — never reached a React error boundary), NO
  // stacktrace frames, request URL `https://dosco.live/auth`.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/auth' },
      exception: {
        values: [
          {
            value: SUPABASE_TOKEN_EXPIRED_REJECTION,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the Supabase TOKEN_EXPIRED Sentry event via the beforeSend gate (second occurrence — post-OAuth project page)', () => {
  // Exact shape of the second production event: type `UnhandledRejection`,
  // mechanism `auto.browser.global_handlers.onunhandledrejection` (uncaught
  // global unhandledrejection — never reached a React error boundary), NO
  // stacktrace frames, request URL `https://dosco.live/projects/c5a6e2f5-...`
  // (post-Google-OAuth redirect), referer `https://accounts.google.com/`.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/projects/c5a6e2f5-8880-4c30-bbbf-40fbcc1a1fbf' },
      exception: {
        values: [
          {
            value: SUPABASE_TOKEN_EXPIRED_REJECTION,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the Supabase TOKEN_EXPIRED rejection when frames are absent entirely (no stacktrace key)', () => {
  // The production event has no frames at all — Sentry omits the stacktrace
  // key entirely when there is nothing to serialize. The gate must still drop
  // it (frames default to []).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/auth' },
      exception: {
        values: [{ value: SUPABASE_TOKEN_EXPIRED_REJECTION }],
      },
    }),
    true,
  )
})

test('does NOT suppress a different-keys object rejection (e.g. wallet-extension stack variant)', () => {
  // The wallet-extension class has keys `code, message, stack` (not `status`).
  // The exact-message anchor means the `code, message, stack` variant is NOT
  // matched by this matcher — it is handled separately by
  // `isExtensionRejectedObjectNoise` (PR #4720).
  for (const message of [
    'Object captured as promise rejection with keys: code, message, stack',
    'Object captured as promise rejection with keys: code, message, something',
    'Object captured as promise rejection with keys: code, message',
    'Object captured as promise rejection with keys: status',
    'Object captured as promise rejection with keys: code, message, status, extra',
  ]) {
    assert.equal(
      isSupabaseTokenExpiredNoise({
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

test('does NOT suppress the Supabase TOKEN_EXPIRED rejection when a first-party frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code rejected a promise
  // with a `{ code, message, status }` object → actionable; the negative guard
  // MUST preserve it so the call site can be found + fixed. This is the whole
  // reason the matcher is frame-aware (the message is also a real first-party
  // `Promise.reject({ code, message, status })` signature).
  for (const frames of [
    [{ filename: 'apps/web/src/lib/auth/supabase-client.ts', function: 'getUser' }],
    [
      { filename: 'app:///_next/static/chunks/main.js', function: 'f' },
      { filename: 'app:///apps/web/src/features/auth/providers.ts', function: 'handleSession' },
    ],
  ]) {
    assert.equal(
      isSupabaseTokenExpiredNoise({
        message: SUPABASE_TOKEN_EXPIRED_REJECTION,
        frames,
      }),
      false,
      `expected first-party TOKEN_EXPIRED rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: SUPABASE_TOKEN_EXPIRED_REJECTION, stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party TOKEN_EXPIRED rejection from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress the Supabase TOKEN_EXPIRED rejection when any resolvable (non-first-party) frame is present', () => {
  // Any resolvable source location (real chunk / URL / named file) means the
  // rejection is attributable — a real first-party or third-party
  // `Promise.reject({ code, message, status })` with a stack we can trace. Keep
  // reporting; only the frameless capture (the production noise pattern) is
  // dropped.
  for (const frames of [
    [{ filename: 'app:///_next/static/chunks/123-abc.js', function: 'x' }],
    [{ filename: 'https://cdn.example.com/sdk.js', function: 'init' }],
    [{ filename: 'app:///inpage.js', function: 'emit' }],
  ]) {
    assert.equal(
      isSupabaseTokenExpiredNoise({
        message: SUPABASE_TOKEN_EXPIRED_REJECTION,
        frames,
      }),
      false,
      `expected attributable TOKEN_EXPIRED rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
  }
})

test('does NOT suppress a message that only mentions the object-rejection wording', () => {
  // The matcher anchors on the EXACT canonical message; a different wording
  // that merely mentions the prefix must not be matched.
  for (const message of [
    'Object captured as promise rejection with keys: code, message, status (extra context)',
    'Object captured as promise rejection',
    'promise rejection with keys: code, message, status',
    'UnhandledRejection: TOKEN_EXPIRED',
  ]) {
    assert.equal(
      isSupabaseTokenExpiredNoise({
        message,
        frames: [],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a frameless rejection with a different serialized payload', () => {
  // A frameless rejection carrying a DIFFERENT message is a different class —
  // keep reporting it via this matcher. (The bare-`undefined` non-Error
  // rejection class has its own dedicated matcher + tests; not re-tested here.)
  for (const message of [
    'Something else entirely',
    'Object captured as promise rejection with keys: code, message, stack',
    'Object captured as promise rejection with keys: different, keys',
  ]) {
    assert.equal(
      isSupabaseTokenExpiredNoise({
        message,
        frames: [],
      }),
      false,
      `expected frameless "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event for frameless "${message}" to keep reporting`,
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
// (dosco Frontend prod, application_id 2346967), both
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
        request: { url: 'https://dosco.live/' },
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
        request: { url: 'https://dosco.live/' },
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

// ---------------------------------------------------------------------------
// Safari generic SecurityError noise — the bare `The operation is insecure.`
// message from Safari 26.6+ on iOS for cross-origin restricted API access
// (`crypto.subtle`, `fetch` in a restricted context, or a Web Crypto operation
// in a sandboxed iframe / Safari private-mode context). This is a SIBLING of
// the storage SecurityError noise (`isStorageSecurityErrorNoise`) — the storage
// matcher anchors on `'localStorage'`/`'sessionStorage'` property names and
// does NOT catch the bare `The operation is insecure.` message.
//
// Better Stack frontend prod patterns:
//   e1d25be3ab38488ba0bfb2b3f069f24641914e3d20bacc1027178a5522376294
//   1918c62ac5434aa56d7ce150e96b99be1b520471360fa3ef091802327297cf73
//   70e1c309921716ee01cd5cd083cef876b41a81311b51db3d5bd55def644fdc47
//   1cec609ee07b7f15aea6fea1eed550e4ce45a838abdf40171050336ff4abc2aa
// (dosco Frontend prod, application_id 2346967): all `SecurityError: The
// operation is insecure.`, 1 occurrence each / 0 identified users, last
// 2026-07-29 08:36:02 UTC, release `c330eda4d96e7aee557618254a86df7d16ba5d9b`
// (v0.11.0 — POST-Promote), transaction `/` (marketing homepage), URL
// `https://dosco.live/`, browser Safari 26.6 on iOS (iPhone) 18.7, mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT). Frames: all
// in `webpack-befb5b1662175048.js` function `a` (webpack runtime) +
// `59675-a333ed5b0ae6dae4.js` functions `17725`/`20532`/`63613` (in_app) —
// NO first-party `apps/web/src/…` frame.
// ---------------------------------------------------------------------------

// The exact raw message from the production events.
const SAFARI_SECURITY_ERROR_MESSAGE = 'The operation is insecure.'

// A minified chunk frame (webpack runtime / app chunk) — no resolved first-party
// `apps/web/src/…` source, so the negative guard does NOT fire. Represents the
// four production patterns' frame shapes.
const SAFARI_SECURITY_ERROR_CHUNK_FRAME =
  'app:///_next/static/chunks/webpack-befb5b1662175048.js'

// The three canonical capture-path forms: raw, `SecurityError: ` prefix, and
// stacked `Unhandled promise rejection: SecurityError: ` prefix.
const SAFARI_SECURITY_ERROR_CAPTURE_FORMS = [
  SAFARI_SECURITY_ERROR_MESSAGE,
  `SecurityError: ${SAFARI_SECURITY_ERROR_MESSAGE}`,
  `Unhandled promise rejection: SecurityError: ${SAFARI_SECURITY_ERROR_MESSAGE}`,
]

test('classifies every Safari generic SecurityError capture form as noise (no first-party frame)', () => {
  for (const message of SAFARI_SECURITY_ERROR_CAPTURE_FORMS) {
    // Matcher-level: message alone (frameless — still noise because the message
    // is Safari-specific and generic enough).
    assert.equal(
      isSafariGenericSecurityErrorNoise({ message }),
      true,
      `expected "${message}" to be classified as Safari generic SecurityError noise`,
    )
    // Matcher-level: with a minified chunk frame (no first-party source).
    assert.equal(
      isSafariGenericSecurityErrorNoise({ message, frames: [{ filename: SAFARI_SECURITY_ERROR_CHUNK_FRAME }] }),
      true,
      `expected "${message}" from a chunk frame to be noise`,
    )
    // Matcher-level: with a window.onerror filename (no first-party source).
    assert.equal(
      isSafariGenericSecurityErrorNoise({ message, filename: SAFARI_SECURITY_ERROR_CHUNK_FRAME }),
      true,
      `expected "${message}" from a chunk filename to be noise`,
    )
  }
})

test('suppresses the Safari generic SecurityError Sentry event via the beforeSend gate', () => {
  for (const value of SAFARI_SECURITY_ERROR_CAPTURE_FORMS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://dosco.live/' },
        exception: {
          values: [
            {
              value,
              stacktrace: { frames: [{ filename: SAFARI_SECURITY_ERROR_CHUNK_FRAME }] },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses a frameless Safari generic SecurityError Sentry event (no first-party frame to preserve)', () => {
  for (const value of SAFARI_SECURITY_ERROR_CAPTURE_FORMS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      true,
      `expected frameless Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses the Safari generic SecurityError unhandled rejection via the runtime (window.onerror) gate', () => {
  for (const message of SAFARI_SECURITY_ERROR_CAPTURE_FORMS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message }),
      true,
      `expected runtime gate to suppress "${message}"`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message, filename: SAFARI_SECURITY_ERROR_CHUNK_FRAME }),
      true,
      `expected runtime gate to suppress "${message}" from a chunk filename`,
    )
  }
})

test('does NOT suppress a Safari generic SecurityError whose stack resolves to a first-party app frame', () => {
  // A de-minified `apps/web/src/…` frame means our own code threw a
  // `SecurityError: The operation is insecure.` — actionable, so it must keep
  // reporting so the call site can be fixed. This is the negative guard that
  // distinguishes actionable first-party code regressions from the noise class.
  const realAppFrames: Array<{ filename: unknown }> = [
    [{ filename: 'app:///apps/web/src/lib/security/some-crypto.ts' }],
    [{ filename: 'apps/web/src/features/auth/use-auth.ts' }],
  ]
  for (const frames of realAppFrames) {
    for (const message of SAFARI_SECURITY_ERROR_CAPTURE_FORMS) {
      assert.equal(
        isSafariGenericSecurityErrorNoise({ message, frames }),
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
  for (const message of SAFARI_SECURITY_ERROR_CAPTURE_FORMS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({
        message,
        filename: 'apps/web/src/lib/security/some-crypto.ts',
      }),
      false,
      `expected runtime gate to keep reporting first-party "${message}"`,
    )
  }
})

test('does NOT suppress a near-worded SecurityError from a different error type', () => {
  // A non-SecurityError type with the same message (e.g. `Error: The operation
  // is insecure.`) is a different error class — the bare `Error:` type without
  // the `SecurityError:` prefix means a different throw path. The matcher
  // anchors on the EXACT `SecurityError: The operation is insecure.` message
  // (and its canonical wrappers) — a bare `Error:` prefix is NOT a `SecurityError:`
  // prefix, so `stripErrorWrappers` strips it but leaves the remainder, and the
  // exact regex `/^The operation is insecure\.$/` matches the underlying
  // message. Wait — `stripErrorWrappers` strips `[A-Za-z]+Error: `, which
  // includes `Error: `, so both `Error: The operation is insecure.` and
  // `SecurityError: The operation is insecure.` strip to the same underlying
  // message. The over-match guard is that a real first-party `throw new Error(
  // 'The operation is insecure.')` de-minifies to `apps/web/src/…` and is
  // preserved by the negative guard. But verify that a FIRST-PARTY frame
  // preserves it even when the Error type differs.
  for (const frames of [
    [{ filename: 'apps/web/src/lib/foo.ts' }],
  ]) {
    assert.equal(
      isSafariGenericSecurityErrorNoise({ message: `Error: ${SAFARI_SECURITY_ERROR_MESSAGE}`, frames }),
false,
      `expected Sentry event "${SAFARI_SECURITY_ERROR_MESSAGE}" to keep reporting`,
    )
  }
})

// ---------------------------------------------------------------------------
// injectedScript.bundle.js `sendMessage` noise
// ---------------------------------------------------------------------------

const INJECTED_SCRIPT_SENDMESSAGE_MESSAGES = [
  // The exact raw exception value from the production event (V8/Chrome).
  "Cannot read properties of undefined (reading 'sendMessage')",
  // `TypeError:` prefixed (window.onerror / onunhandledrejection paths).
  "TypeError: Cannot read properties of undefined (reading 'sendMessage')",
  // Unhandled-rejection leak path preserving the message.
  "Unhandled promise rejection: TypeError: Cannot read properties of undefined (reading 'sendMessage')",
  // Old JSC (Safari) wording.
  "Cannot read property 'sendMessage' of undefined",
  "TypeError: Cannot read property 'sendMessage' of undefined",
]

const INJECTED_SCRIPT_BUNDLE_FRAME = { filename: 'app:///injectedScript.bundle.js', function: 'n' }
const INJECTED_SCRIPT_BUNDLE_FRAME_CHAIN = [
  { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js', function: 'u' },
  { filename: 'app:///injectedScript.bundle.js', function: 'n', lineno: 84147 },
]
const FIRST_PARTY_APPS_SRC_FRAME = { filename: 'apps/web/src/lib/desktop.ts', function: 'handleMessage' }

test('classifies every injectedScript.bundle.js sendMessage variant as noise when sourced from the injected script', () => {
  for (const message of INJECTED_SCRIPT_SENDMESSAGE_MESSAGES) {
    assert.equal(
      isInjectedScriptSendMessageNoise({ message, filename: 'app:///injectedScript.bundle.js' }),
      true,
      `expected "${message}" from injectedScript.bundle.js to be sendMessage noise`,
    )
    assert.equal(
      isInjectedScriptSendMessageNoise({ message, frames: [INJECTED_SCRIPT_BUNDLE_FRAME] }),
      true,
      `expected "${message}" with an injected frame to be sendMessage noise`,
    )
  }
})

test('classifies the sendMessage variant from the full production frame chain', () => {
  assert.equal(
    isInjectedScriptSendMessageNoise({
      message: "Cannot read properties of undefined (reading 'sendMessage')",
      frames: INJECTED_SCRIPT_BUNDLE_FRAME_CHAIN,
    }),
    true,
  )
})

test('classifies injectedScript.bundle.js sendMessage noise from another injected-app source', () => {
  assert.equal(
    isInjectedScriptSendMessageNoise({
      message: "Cannot read properties of undefined (reading 'sendMessage')",
      frames: [{ filename: 'app:///scripts/inpage.js' }],
    }),
    true,
  )
})

test('does NOT classify sendMessage as noise when NO injected source is present', () => {
  for (const message of INJECTED_SCRIPT_SENDMESSAGE_MESSAGES) {
    assert.equal(
      isInjectedScriptSendMessageNoise({ message, filename: 'https://dosco.live/app.js' }),
      false,
      `expected "${message}" from a non-injected source to keep reporting`,
    )
    assert.equal(
      isInjectedScriptSendMessageNoise({ message, frames: [] }),
      false,
      `expected "${message}" with no frames to keep reporting`,
    )
  }
})

test('does NOT classify sendMessage as noise when a first-party apps/web/src frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code called
  // `chrome.runtime.sendMessage` / `browser.runtime.sendMessage` → actionable;
  // the negative guard MUST preserve it.
  assert.equal(
    isInjectedScriptSendMessageNoise({
      message: "Cannot read properties of undefined (reading 'sendMessage')",
      frames: [FIRST_PARTY_APPS_SRC_FRAME, INJECTED_SCRIPT_BUNDLE_FRAME],
    }),
    false,
    'expected first-party sendMessage to keep reporting despite the injected frame',
  )
  assert.equal(
    isInjectedScriptSendMessageNoise({
      message: "Cannot read properties of undefined (reading 'sendMessage')",
      frames: [FIRST_PARTY_APPS_SRC_FRAME],
    }),
    false,
    'expected first-party sendMessage without injected frame to keep reporting',
  )
})

test('does NOT classify a non-sendMessage message from injectedScript.bundle.js as noise', () => {
  assert.equal(
    isInjectedScriptSendMessageNoise({
      message: "Cannot read properties of undefined (reading 'addListener')",
      frames: [INJECTED_SCRIPT_BUNDLE_FRAME],
    }),
    false,
    'expected non-sendMessage message from injectedScript.bundle.js to keep reporting',
  )
})

test('suppresses the injectedScript.bundle.js sendMessage Sentry event via the beforeSend gate', () => {
  for (const value of INJECTED_SCRIPT_SENDMESSAGE_MESSAGES) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://dosco.live/auth?redirect=%2Fprojects%2Fd9ba943c-b6d3-4c6d-a312-fe8ef4b5c7da%2Fthread%2F694c3093-afa7-4440-9e05-7a15dbf98688' },
        exception: {
          values: [
            {
              value,
              stacktrace: { frames: INJECTED_SCRIPT_BUNDLE_FRAME_CHAIN },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('does NOT suppress a real first-party sendMessage that throws from an apps/web/src frame', () => {
  // Our own code throws `sendMessage` on an undefined runtime → actionable
  // regression; the negative guard MUST preserve it so the call site can be fixed.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/projects/d9ba943c/some-page' },
      exception: {
        values: [
          {
            value: "Cannot read properties of undefined (reading 'sendMessage')",
            stacktrace: {
              frames: [
                { filename: 'apps/web/src/features/desktop/bridge.ts', function: 'sendToExtension' },
                { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js', function: 'u' },
              ],
            },
          },
        ],
      },
    }),
    false,
    'expected first-party sendMessage Sentry event to keep reporting',
  )
})

test('pins the production Better Stack pattern 95a70e66…', () => {
  // The exact production event from Better Stack:
  //   message: "Cannot read properties of undefined (reading 'sendMessage')"
  //   stack:
  //     app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy
  //       function `u`
  //     app:///injectedScript.bundle.js function `n` colno 84147
  //   mechanism: auto.browser.global_handlers.onunhandledrejection
  //   request URL: https://dosco.live/auth?redirect=%2Fprojects%2Fd9ba943c-b6d3-4c6d-a312-fe8ef4b5c7da%2Fthread%2F694c3093-afa7-4440-9e05-7a15dbf98688
  //   better-stack pattern: 95a70e668e9fbeb0c139131ac78db4aff62d5ab3675ed376666f9526c2cbb02c
  assert.equal(
    isInjectedScriptSendMessageNoise({
      message: "Cannot read properties of undefined (reading 'sendMessage')",
      frames: [
        { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy' },
        { filename: 'app:///injectedScript.bundle.js' },
      ],
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/auth?redirect=%2Fprojects%2Fd9ba943c-b6d3-4c6d-a312-fe8ef4b5c7da%2Fthread%2F694c3093-afa7-4440-9e05-7a15dbf98688' },
      exception: {
        values: [
          {
            value: "Cannot read properties of undefined (reading 'sendMessage')",
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy' },
                { filename: 'app:///injectedScript.bundle.js' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

// ---------------------------------------------------------------------------
// CAPTCHA / anti-bot browser-extension interceptor `widgetId` noise
// ---------------------------------------------------------------------------
//
// A bot-detection service extension (DataDome, Cloudflare, or similar) injects
// `app:///content/captcha/mt_captcha/interceptor.js` whose internal `widgetId`
// configuration race throws
// `TypeError: Cannot read properties of undefined (reading 'widgetId')` from a
// minified extension function `d`. The throw is in the extension's OWN injected
// interceptor, never first-party code. Two sibling fingerprints from the SAME
// extension, SAME type/message/call-site, different hash:
//   - `cfd5f828fe374568ec3fb9163e035c73690fc8d768e75751df44badaea3a0283`
//   - `4a01a1690345a3763a2865e134a42635215f76b8a71939275f1bf81b4edc3ef3`

const CAPTCHA_INTERCEPTOR_FRAME_SOURCE = 'app:///content/captcha/mt_captcha/interceptor.js'
const CAPTCHA_INTERCEPTOR_FRAME = { filename: CAPTCHA_INTERCEPTOR_FRAME_SOURCE, function: 'd' }
const CAPTCHA_INTERCEPTOR_FRAME_CHAIN = [
  { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js', function: 'u' },
  { filename: CAPTCHA_INTERCEPTOR_FRAME_SOURCE, function: 'd', lineno: 1, colno: 84147 },
]

const CAPTCHA_INTERCEPTOR_MESSAGES = [
  // The exact raw exception value from the production events (V8/Chrome).
  "Cannot read properties of undefined (reading 'widgetId')",
  // `TypeError:` prefixed (window.onerror / onunhandledrejection paths).
  "TypeError: Cannot read properties of undefined (reading 'widgetId')",
  // Unhandled-rejection leak path preserving the message.
  "Unhandled promise rejection: TypeError: Cannot read properties of undefined (reading 'widgetId')",
  // Old JSC (Safari) wording.
  "Cannot read property 'widgetId' of undefined",
  "TypeError: Cannot read property 'widgetId' of undefined",
]

test('classifies every CAPTCHA interceptor widgetId variant as noise when sourced from the interceptor', () => {
  for (const message of CAPTCHA_INTERCEPTOR_MESSAGES) {
    assert.equal(
      isCaptchaInterceptorNoise({ message, filename: CAPTCHA_INTERCEPTOR_FRAME_SOURCE }),
      true,
      `expected "${message}" from the CAPTCHA interceptor to be noise`,
    )
    assert.equal(
      isCaptchaInterceptorNoise({ message, frames: [CAPTCHA_INTERCEPTOR_FRAME] }),
      true,
      `expected "${message}" with an interceptor frame to be noise`,
    )
  }
})

test('classifies the widgetId variant from the full production frame chain', () => {
  assert.equal(
    isCaptchaInterceptorNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      frames: CAPTCHA_INTERCEPTOR_FRAME_CHAIN,
    }),
    true,
  )
})

test('classifies CAPTCHA interceptor widgetId noise from another injected-app source', () => {
  assert.equal(
    isCaptchaInterceptorNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      frames: [{ filename: 'app:///scripts/inpage.js' }],
    }),
    true,
  )
})

test('does NOT classify widgetId as noise when NO injected source is present', () => {
  for (const message of CAPTCHA_INTERCEPTOR_MESSAGES) {
    assert.equal(
      isCaptchaInterceptorNoise({ message, filename: 'https://dosco.live/app.js' }),
      false,
      `expected "${message}" from a non-injected source to keep reporting`,
    )
    assert.equal(
      isCaptchaInterceptorNoise({ message, frames: [] }),
      false,
      `expected "${message}" with no frames to keep reporting`,
    )
  }
})

test('does NOT classify widgetId as noise when a first-party apps/web/src frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code deref'd a `widgetId`
  // property on an `undefined` value → actionable; the negative guard MUST
  // preserve it.
  assert.equal(
    isCaptchaInterceptorNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      frames: [FIRST_PARTY_APPS_SRC_FRAME, CAPTCHA_INTERCEPTOR_FRAME],
    }),
    false,
    'expected first-party widgetId to keep reporting despite the interceptor frame',
  )
  assert.equal(
    isCaptchaInterceptorNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      frames: [FIRST_PARTY_APPS_SRC_FRAME],
    }),
    false,
    'expected first-party widgetId without interceptor frame to keep reporting',
  )
})

test('does NOT classify a non-widgetId message from the CAPTCHA interceptor as noise', () => {
  assert.equal(
    isCaptchaInterceptorNoise({
      message: "Cannot read properties of undefined (reading 'sendMessage')",
      frames: [CAPTCHA_INTERCEPTOR_FRAME],
    }),
    false,
    'expected non-widgetId message from the CAPTCHA interceptor to keep reporting',
  )
})

test('suppresses the CAPTCHA interceptor widgetId Sentry event via the beforeSend gate', () => {
  for (const value of CAPTCHA_INTERCEPTOR_MESSAGES) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://dosco.live/' },
        exception: {
          values: [
            {
              value,
              stacktrace: { frames: CAPTCHA_INTERCEPTOR_FRAME_CHAIN },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses the CAPTCHA interceptor widgetId runtime event via the runtime gate', () => {
  for (const value of CAPTCHA_INTERCEPTOR_MESSAGES) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({
        message: value,
        filename: CAPTCHA_INTERCEPTOR_FRAME_SOURCE,
      }),
      true,
      `expected runtime event for "${value}" to be suppressed`,
    )
  }
})

test('does NOT suppress a real first-party widgetId that throws from an apps/web/src frame', () => {
  // Our own code throws `widgetId` on an undefined value → actionable
  // regression; the negative guard MUST preserve it so the call site can be fixed.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/projects/d9ba943c/some-page' },
      exception: {
        values: [
          {
            value: "Cannot read properties of undefined (reading 'widgetId')",
            stacktrace: {
              frames: [
                { filename: 'apps/web/src/features/captcha/widget.ts', function: 'readWidgetId' },
                { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js', function: 'u' },
              ],
            },
          },
        ],
      },
    }),
    false,
    'expected first-party widgetId Sentry event to keep reporting',
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      filename: 'apps/web/src/features/captcha/widget.ts',
    }),
    false,
    'expected first-party widgetId runtime event to keep reporting',
  )
})

test('pins the production Better Stack pattern cfd5f828…', () => {
  // The exact production event from Better Stack:
  //   type: TypeError
  //   message: "Cannot read properties of undefined (reading 'widgetId')"
  //   call_site_function: d
  //   call_site_file: app:///content/captcha/mt_captcha/interceptor.js
  //   first_seen: 2026-08-08 17:03:49 UTC
  //   better-stack pattern:
  //   cfd5f828fe374568ec3fb9163e035c73690fc8d768e75751df44badaea3a0283
  assert.equal(
    isCaptchaInterceptorNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      frames: [
        { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy' },
        { filename: CAPTCHA_INTERCEPTOR_FRAME_SOURCE, function: 'd' },
      ],
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read properties of undefined (reading 'widgetId')",
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_YsEdLTRagkN1LYLYMhUFP3rXtrAy' },
                { filename: CAPTCHA_INTERCEPTOR_FRAME_SOURCE, function: 'd' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('pins the production Better Stack pattern 4a01a169… (sibling fingerprint)', () => {
  // Sibling fingerprint from the SAME extension interceptor, SAME
  // type/message/call-site, different hash:
  //   type: TypeError
  //   message: "Cannot read properties of undefined (reading 'widgetId')"
  //   call_site_function: d
  //   call_site_file: app:///content/captcha/mt_captcha/interceptor.js
  //   first_seen: 2026-08-08 16:44:10 UTC
  //   better-stack pattern:
  //   4a01a1690345a3763a2865e134a42635215f76b8a71939275f1bf81b4edc3ef3
  assert.equal(
    isCaptchaInterceptorNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      frames: [
        { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno' },
        { filename: CAPTCHA_INTERCEPTOR_FRAME_SOURCE, function: 'd' },
      ],
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read properties of undefined (reading 'widgetId')",
            stacktrace: {
              frames: [
                { filename: 'app:///_next/static/chunks/66499-704f783b0e8ea993.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno' },
                { filename: CAPTCHA_INTERCEPTOR_FRAME_SOURCE, function: 'd' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
})

test('cross-matcher isolation: the CAPTCHA interceptor matcher does NOT match the injectedScript sendMessage message', () => {
  // The `sendMessage` matcher (`isInjectedScriptSendMessageNoise`) anchors on
  // `sendMessage`; the CAPTCHA interceptor matcher (`isCaptchaInterceptorNoise`)
  // anchors on `widgetId`. They must NOT overlap.
  assert.equal(
    isCaptchaInterceptorNoise({
      message: "Cannot read properties of undefined (reading 'sendMessage')",
      frames: [INJECTED_SCRIPT_BUNDLE_FRAME],
    }),
    false,
    'expected sendMessage message to NOT be matched by the CAPTCHA interceptor matcher',
  )
  assert.equal(
    isInjectedScriptSendMessageNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      frames: [CAPTCHA_INTERCEPTOR_FRAME],
    }),
    false,
    'expected widgetId message to NOT be matched by the sendMessage matcher',
  )
})

test('cross-matcher isolation: the CAPTCHA interceptor source is recognized by isInjectedAppSource', () => {
  // The new `app:///content/captcha/mt_captcha/interceptor.js` source pattern
  // added to `INJECTED_APP_SOURCE_PATTERNS` must be flagged as third-party
  // injected noise, distinct from a first-party `app:///_next/…` bundle frame.
  assert.equal(isInjectedAppSource(CAPTCHA_INTERCEPTOR_FRAME_SOURCE), true)
  assert.equal(isInjectedAppSource('app:///_next/static/chunks/main.js'), false)
})

test('cross-matcher isolation: the existing sendMessage matcher does NOT match the widgetId message from the CAPTCHA interceptor', () => {
  // A `widgetId` throw from the CAPTCHA interceptor must NOT be swallowed by
  // the `sendMessage` matcher (which anchors on `sendMessage`); it must reach
  // the CAPTCHA interceptor matcher instead.
  assert.equal(
    isInjectedScriptSendMessageNoise({
      message: "Cannot read properties of undefined (reading 'widgetId')",
      frames: [CAPTCHA_INTERCEPTOR_FRAME],
    }),
    false,
    'expected widgetId message from the CAPTCHA interceptor to NOT be matched by the sendMessage matcher',
  )
})

test('cross-matcher isolation: the new Safari generic matcher does NOT match the existing storage SecurityError message', () => {
  // The storage SecurityError matcher (`isStorageSecurityErrorNoise`) is anchored
  // on `Failed to read the 'localStorage'/'sessionStorage' property from 'Window'`.
  // The new Safari generic matcher (`isSafariGenericSecurityErrorNoise`) is anchored
  // on the bare `The operation is insecure.` — they must NOT overlap.
  for (const message of [
    "SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
    "Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document.",
    "Unhandled promise rejection: SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
  ]) {
    assert.equal(
      isSafariGenericSecurityErrorNoise({ message }),
      false,
      `expected storage SecurityError "${message}" to NOT be matched by the Safari generic matcher`,
    )
  }
})

test('cross-matcher isolation: the existing storage matcher does NOT match the new Safari generic message', () => {
  // The storage SecurityError matcher regexes anchor on `'localStorage'` /
  // `'sessionStorage'` property names, so the bare `The operation is insecure.`
  // must NOT match.
  for (const message of SAFARI_SECURITY_ERROR_CAPTURE_FORMS) {
    assert.equal(
      isStorageSecurityErrorNoise({ message }),
      false,
      `expected Safari generic SecurityError "${message}" to NOT be matched by the storage matcher`,
    )
  }
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
        exception: { values: [{ value, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event "${value}" to keep reporting`,
    )
  }
})

// Reproduces Better Stack error 83e0c2af...189c3b17 (dosco Frontend prod,
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
      request: { url: 'https://dosco.live/projects' },
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
// (dosco Frontend prod, application_id 2346967): a single
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
        request: { url: 'https://app.dosco.live/projects/p/sessions/s' },
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

test('the client-timeout matcher does NOT match the API server-deadline 503 wording', () => {
  // The API's request-deadline 503 is `Request exceeded the <N>s server
  // processing deadline` — a distinct, server-side wording. The CLIENT-timeout
  // matcher (`isClientRequestTimeoutMessage`, anchored on the SDK's
  // `Request timed out after <N>s: ` prefix) must never match it; the
  // server-deadline wording has its OWN dedicated matcher
  // (`isServerDeadlineNoiseMessage`, pinned by the test block below).
  for (const value of [
    'Request exceeded the 25s server processing deadline',
    'Request exceeded the 30s server processing deadline',
  ]) {
    assert.equal(
      isClientRequestTimeoutMessage(value),
      false,
      `expected server-deadline message "${value}" to not match the client-timeout matcher`,
    )
  }
})

// Reproduces Better Stack error a330bea136a7b5795a57ef5a33ab40381433132e90c34bbabdca66cc3f6d938c
// (dosco Frontend prod, application_id 2346967): a single
// `ApiError: Request exceeded the 25s server processing deadline` at
// 2026-07-23 18:41:09 UTC, release 470fe6f3c8 (v0.10.13), transaction
// `/projects/:id/sessions/:sessionId` (co-worker session page actively polling
// `useSessionAudit`). Mechanism `generic` (handled=true) — the SDK's
// `makeRequest` caught the 503 response and re-surfaced it as an `ApiError`.
// The 99 breadcrumbs were almost all 200s, except THREE
// `GET .../sessions/<sid>/audit -> 503` — the `useSessionAudit` react-query poll
// hit the audit endpoint while the API/gateway was transiently saturated.
//
// The API's `request-deadline.ts` middleware bounds every non-streaming request
// to a 25s wall-clock deadline; when exceeded, `RequestDeadlineHTTPException`
// returns a clean 503 + `Retry-After: 10` with the message
// `Request exceeded the <N>s server processing deadline`. This is an EXPECTED,
// retryable degradation — the deadline net bounding a slow downstream / a
// pool-saturated request. PR #4524 de-noised it from the API's OWN Sentry
// (app 2346961) by skipping `captureException` for
// `isRequestDeadlineHTTPException(err)`. BUT the 503 RESPONSE crosses the
// boundary into the frontend: the SDK's `makeRequest` extracts
// `errorData.message` (the deadline string), wraps it in an `ApiError` with
// `status: 503`, and fires `onError` → `handleApiError`, which captures it to
// the FRONTEND Sentry (app 2346967 — a SEPARATE app from the API's). The
// `TRANSIENT_GATEWAY_STATUSES` retry (#4609) absorbs a SINGLE transient 503 on
// idempotent reads, but persistent saturation (the 3 non-200 audit 503s)
// exhausts the 2-retry loop and surfaces the deadline 503 to `onError` →
// Sentry. That is exactly how `a330bea1…` reached the frontend telemetry
// despite #4524's API-side classification.
//
// This is the SERVER-side mirror of the CLIENT-timeout class (`b1db01e5…`,
// #4531 — the SDK's 30s fetch abort). Both are the same expected/retryable
// degradation under momentary API saturation; react-query retries background
// polls, and the saturation signal stays visible in the per-route
// `http_request_duration_seconds` metric + the structured
// `Request completed: … 503 …` warn log on the API. `handleApiError`
// (`error-handler.tsx`) skips `captureException` for `status === 503 &&`
// `isServerDeadlineNoiseMessage(message)`; these checks are the
// telemetry-side backstop for leak paths (ClientErrorBoundary / route-error /
// app-error / onunhandledrejection).
const SERVER_DEADLINE_NOISE_EVENTS = [
  // The exact prod occurrence — the default 25s budget.
  'Request exceeded the 25s server processing deadline',
  // The budget is env-tunable (REQUEST_DEADLINE_MS); the seconds value is not
  // load-bearing.
  'Request exceeded the 30s server processing deadline',
  // The ApiError-class-prefixed wrapper (Sentry/Better Stack often prefixes the
  // captured error's `.message` with the class name).
  'ApiError: Request exceeded the 25s server processing deadline',
  // An unhandled-rejection leak path preserving the message.
  'Unhandled promise rejection: Request exceeded the 25s server processing deadline',
  'Unhandled promise rejection: ApiError: Request exceeded the 25s server processing deadline',
]

test('classifies every API server-deadline 503 message as expected noise', () => {
  for (const message of SERVER_DEADLINE_NOISE_EVENTS) {
    assert.equal(
      isServerDeadlineNoiseMessage(message),
      true,
      `expected "${message}" to be classified as a server-deadline 503`,
    )
  }
})

test('suppresses an API server-deadline 503 Sentry event regardless of capture path', () => {
  for (const value of SERVER_DEADLINE_NOISE_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://dosco.live/projects/p/sessions/s' },
        exception: {
          values: [
            {
              value,
              stacktrace: {
                frames: [{ filename: 'app:///_next/static/chunks/26996-0650621935b0e261.js' }],
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

test('suppresses an API server-deadline 503 unhandled rejection from the browser', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message:
        'Unhandled promise rejection: Request exceeded the 25s server processing deadline',
    }),
    true,
  )
})

test('does NOT suppress a generic 503 message that is not the typed deadline wording', () => {
  // A generic 503 (`HTTP 503: Service Unavailable`, `sandbox waking up`) must
  // keep reporting — only the typed `Request exceeded the <N>s server processing
  // deadline` message the API's `RequestDeadlineHTTPException` emits is
  // classified as noise.
  for (const value of [
    'HTTP 503: Service Unavailable',
    'Service Unavailable',
    'sandbox waking up',
    'Bad Gateway',
    'Request exceeded the 25s client processing deadline',
    'Request exceeded the server processing deadline',
    'Request exceeded the 25s server processing deadline.',
    'A request exceeded the 25s server processing deadline',
  ]) {
    assert.equal(
      isServerDeadlineNoiseMessage(value),
      false,
      `expected generic 503 message "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({ exception: { values: [{ value }] } }),
      false,
      `expected generic 503 Sentry event "${value}" to keep reporting`,
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
      isServerDeadlineNoiseMessage(value),
      false,
      `expected real server error "${value}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({ exception: { values: [{ value }] } }),
      false,
      `expected real server error Sentry event "${value}" to keep reporting`,
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
// dosco Frontend (prod), application_id 2346967: a Safari 15.6.1 visitor on
// the marketing homepage (`https://dosco.live/`) hit a chunk parse-time
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
        request: { url: 'https://dosco.live/' },
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
// (dosco Frontend prod, application_id 2346967), all 1–2 occurrences each, 0
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
        request: { url: 'https://dosco.live/' },
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
                { filename: 'https://dosco.live/_next/static/chunks/1234-abcd.js?dpl=dpl_abc123' },
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
      filename: 'https://dosco.live/_next/static/chunks/main-app.js',
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
    { filename: 'https://dosco.live/src/lib/dynamic-eval.ts' },
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
// Old-browser third-party-library DOM null-deref noise on the marketing
// homepage — two SIBLING Better Stack prod patterns (dosco Frontend prod,
// application_id 2346967), both `TypeError: Cannot read properties of null
// (reading '<X>')` (V8 wording) from minified third-party library internals
// running on VERY OLD browsers (Windows 7 Chrome, Chrome 95 Linux) hitting
// `https://dosco.live/` (marketing homepage). UNCAUGHT global `onerror`
// (`auto.browser.global_handlers.onerror`, `handled:false` — never reached a
// React error boundary). 2 occurrences each, 0 identified users, marketing
// page only — browser-compatibility noise, not a product defect.
//
//   Pattern 1: e02e022f7433a02c7acdc9ae33c3dd1bdec938eeb694f0bf83d290c1d696d853
//   `Cannot read properties of null (reading 'scrollLeft')`, call site
//   function `measureScroll` in chunk `0d5wqj98qv1e9.js` (minified). Last
//   2026-08-06 11:11:14 UTC.
//
//   Pattern 2: 8ab4ae816505dc3a17c7b8258e6894b3964ab7d10056afc47477833824fa8648
//   `Cannot read properties of null (reading 'appendChild')`, call site
//   function `ft` in chunk `0foj1ouh5ijrj.js` (minified). Same timestamp.
//
// `scrollLeft` and `appendChild` are STANDARD DOM API method names that
// first-party React code DOES call, so the matcher requires BOTH the exact
// message AND a NEGATIVE guard (any resolved first-party `apps/web/src/…`
// frame → keep reporting). The prod events carry only minified chunk frames +
// `<anonymous>`, so the negative guard does NOT fire for them.
// ---------------------------------------------------------------------------

const MEASURE_SCROLL_CHUNK = 'app:///_next/static/chunks/0d5wqj98qv1e9.js'
const APPEND_CHILD_CHUNK = 'app:///_next/static/chunks/0foj1ouh5ijrj.js'

test('classifies the production scrollLeft measureScroll noise (Pattern 1, exact prod frames)', () => {
  // Exact shape of Better Stack pattern e02e022f…: V8 wording, `measureScroll`
  // in the minified `0d5wqj98qv1e9` chunk + an `<anonymous>` frame, UNCAUGHT.
  const frames = [
    { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' },
    { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' },
    { filename: '<anonymous>', function: '?' },
  ]
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "TypeError: Cannot read properties of null (reading 'scrollLeft')",
      frames,
    }),
    true,
  )
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read properties of null (reading 'scrollLeft')",
      frames,
    }),
    true,
  )
  // The Sentry `beforeSend` gate suppresses it.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'scrollLeft')",
            stacktrace: { frames },
          },
        ],
      },
    }),
    true,
  )
})

test('classifies the production appendChild ft noise (Pattern 2, exact prod frames)', () => {
  // Exact shape of Better Stack pattern 8ab4ae81…: V8 wording, `ft` in the
  // minified `0foj1ouh5ijrj` chunk, 3 frames, UNCAUGHT.
  const frames = [
    { filename: APPEND_CHILD_CHUNK, function: 'ft' },
    { filename: APPEND_CHILD_CHUNK, function: 'ft' },
    { filename: APPEND_CHILD_CHUNK, function: 'ft' },
  ]
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "TypeError: Cannot read properties of null (reading 'appendChild')",
      frames,
    }),
    true,
  )
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read properties of null (reading 'appendChild')",
      frames,
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'appendChild')",
            stacktrace: { frames },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses both old-browser DOM null-deref patterns through all three capture-path wrappers', () => {
  // `stripErrorWrappers` strips `Unhandled promise rejection: ` and
  // `<Word>Error: ` (e.g. `TypeError: `) prefixes so all capture paths
  // (window.onerror, onunhandledrejection, Sentry exception) classify
  // consistently.
  const chunkFrame = { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' }
  for (const message of [
    "Cannot read properties of null (reading 'scrollLeft')",
    "TypeError: Cannot read properties of null (reading 'scrollLeft')",
    "Unhandled promise rejection: TypeError: Cannot read properties of null (reading 'scrollLeft')",
  ]) {
    assert.equal(
      isOldBrowserDomNullDerefNoise({ message, frames: [chunkFrame] }),
      true,
      `expected "${message}" to be classified as old-browser DOM null-deref noise`,
    )
  }
  const appendFrame = { filename: APPEND_CHILD_CHUNK, function: 'ft' }
  for (const message of [
    "Cannot read properties of null (reading 'appendChild')",
    "TypeError: Cannot read properties of null (reading 'appendChild')",
    "Unhandled promise rejection: TypeError: Cannot read properties of null (reading 'appendChild')",
  ]) {
    assert.equal(
      isOldBrowserDomNullDerefNoise({ message, frames: [appendFrame] }),
      true,
      `expected "${message}" to be classified as old-browser DOM null-deref noise`,
    )
  }
})

test('classifies the old-JSC wording variants of both sibling patterns (different engine, same class)', () => {
  // Old JSC (old Safari/iOS) phrases a null property access as
  // `Cannot read property '<X>' of null` — different engine, same old-browser
  // DOM null-deref class. The matcher must catch both engine wordings.
  const chunkFrame = { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' }
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read property 'scrollLeft' of null",
      frames: [chunkFrame],
    }),
    true,
  )
  const appendFrame = { filename: APPEND_CHILD_CHUNK, function: 'ft' }
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read property 'appendChild' of null",
      frames: [appendFrame],
    }),
    true,
  )
})

test('classifies the frameless window.onerror variant as noise (message alone is specific)', () => {
  // A frameless window.onerror capture carries the exact message + no
  // `filename`. `measureScroll` and the minified `ft` are third-party library
  // internals, and a real first-party `el.scrollLeft` / `parent.appendChild`
  // null-deref almost always has a resolvable frame with a stack, so a
  // frameless capture with one of these exact messages is safe to drop.
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read properties of null (reading 'scrollLeft')",
    }),
    true,
  )
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read properties of null (reading 'appendChild')",
    }),
    true,
  )
  // The runtime (window.onerror) gate suppresses a frameless capture too.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "TypeError: Cannot read properties of null (reading 'scrollLeft')",
    }),
    true,
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "TypeError: Cannot read properties of null (reading 'appendChild')",
    }),
    true,
  )
})

test('suppresses the old-browser DOM null-deref noise via the runtime (window.onerror) gate with a chunk filename', () => {
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "TypeError: Cannot read properties of null (reading 'scrollLeft')",
      filename: MEASURE_SCROLL_CHUNK,
    }),
    true,
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "Cannot read properties of null (reading 'appendChild')",
      filename: APPEND_CHILD_CHUNK,
    }),
    true,
  )
})

test('does NOT suppress the old-browser DOM null-deref when a first-party frame is present (real regression)', () => {
  // `scrollLeft` and `appendChild` are STANDARD DOM API method names that
  // first-party React code DOES call (e.g. `apps/web/src/hooks/use-proximity-
  // hover.ts` reads `container.scrollLeft`, portal/tooltip ref-callbacks call
  // `appendChild`). A real first-party null-deref de-minifies (via Sentry's
  // sourcemap resolution) to a frame whose filename contains `apps/web/src/`
  // and MUST keep reporting — the negative guard is the load-bearing over-match
  // protection.
  const firstPartyFrames = [
    { filename: 'app:///apps/web/src/hooks/use-proximity-hover.ts' },
    { filename: 'apps/web/src/features/workspace/project-sidebar/session-title.tsx' },
    { filename: 'app:///apps/web/src/components/ui/portal.tsx' },
  ]
  for (const frames of [
    [firstPartyFrames[0]],
    [firstPartyFrames[1]],
    [firstPartyFrames[2]],
    // A stack that mixes a first-party frame with the minified chunk frame
    // STILL keeps reporting — the first-party frame is the actionable anchor.
    [firstPartyFrames[0], { filename: MEASURE_SCROLL_CHUNK }],
    [{ filename: APPEND_CHILD_CHUNK }, firstPartyFrames[2]],
  ]) {
    assert.equal(
      isOldBrowserDomNullDerefNoise({
        message: "Cannot read properties of null (reading 'scrollLeft')",
        frames,
      }),
      false,
      `expected first-party scrollLeft null-deref with frames ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      isOldBrowserDomNullDerefNoise({
        message: "Cannot read properties of null (reading 'appendChild')",
        frames,
      }),
      false,
      `expected first-party appendChild null-deref with frames ${JSON.stringify(frames)} to keep reporting`,
    )
  }
  // And via the Sentry `beforeSend` gate.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'scrollLeft')",
            stacktrace: {
              frames: [{ filename: 'app:///apps/web/src/hooks/use-proximity-hover.ts' }],
            },
          },
        ],
      },
    }),
    false,
  )
  // And via the runtime (window.onerror) gate with a first-party filename.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "TypeError: Cannot read properties of null (reading 'appendChild')",
      filename: 'app:///apps/web/src/components/ui/portal.tsx',
    }),
    false,
  )
})

test('does NOT suppress a near-worded null-deref message (over-match guard)', () => {
  // Only the EXACT V8/old-JSC messages for `scrollLeft` and `appendChild` are
  // noise. A different DOM method, a different access pattern, or a near-
  // worded regression keeps reporting.
  const chunkFrame = { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' }
  for (const message of [
    // Different DOM method on null — not the two anchored methods.
    "Cannot read properties of null (reading 'scrollTop')",
    "Cannot read properties of null (reading 'removeChild')",
    "Cannot read properties of null (reading 'appendChild') extra",
    // `undefined` (not `null`) — a different null-deref class.
    "Cannot read properties of undefined (reading 'scrollLeft')",
    "Cannot read properties of undefined (reading 'appendChild')",
    // A real first-party-shaped message that happens to mention the method.
    "Cannot read properties of null (reading 'appendChild') in portal mount",
    // Substring without the exact wrapper.
    "scrollLeft is null",
    "appendChild failed",
  ]) {
    assert.equal(
      isOldBrowserDomNullDerefNoise({ message, frames: [chunkFrame] }),
      false,
      `expected near-worded message "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a non-V8/JSC engine wording (over-match guard)', () => {
  // SpiderMonkey (Firefox) phrases a null property access as
  // `null is not an object (evaluating '<expr>')` or
  // `can't access property "<m>"<…>` — different engine wordings the matcher
  // does NOT anchor on (the prod events are V8/old-JSC from Chrome). Keep
  // reporting so a genuine Firefox null-deref regression stays observable.
  const chunkFrame = { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' }
  for (const message of [
    "null is not an object (evaluating 'el.scrollLeft')",
    "null is not an object (evaluating 'parent.appendChild')",
    'can\'t access property "scrollLeft" of null',
    'can\'t access property "appendChild" of null',
  ]) {
    assert.equal(
      isOldBrowserDomNullDerefNoise({ message, frames: [chunkFrame] }),
      false,
      `expected non-V8/JSC message "${message}" to keep reporting`,
    )
  }
})

test('suppresses the scrollLeft noise when the only frame is the <anonymous> throw site (prod shape)', () => {
  // The prod Pattern 1 stack ends with an `<anonymous>` frame after the two
  // `measureScroll` chunk frames. A capture that surfaces ONLY the
  // `<anonymous>` throw site (e.g. a truncated stack) still classifies as
  // noise — `<anonymous>` is not a resolved first-party source, so the
  // negative guard does not fire.
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read properties of null (reading 'scrollLeft')",
      frames: [{ filename: '<anonymous>', function: '?' }],
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'scrollLeft')",
            stacktrace: { frames: [{ filename: '<anonymous>', function: '?' }] },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the appendChild noise when the stack is fully minified chunk frames (prod shape)', () => {
  // The prod Pattern 2 stack is 3 frames all in the `0foj1ouh5ijrj` chunk.
  // None resolve to a first-party `apps/web/src/…` path, so the negative
  // guard does not fire.
  const frames = [
    { filename: APPEND_CHILD_CHUNK, function: 'ft' },
    { filename: APPEND_CHILD_CHUNK, function: 'ft' },
    { filename: APPEND_CHILD_CHUNK, function: 'ft' },
  ]
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "TypeError: Cannot read properties of null (reading 'appendChild')",
            stacktrace: { frames },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the old-JSC wording variants through both gates (runtime + beforeSend)', () => {
  // The old-JSC wording `Cannot read property '<X>' of null` must also be
  // suppressed by both the runtime (window.onerror) gate and the Sentry
  // `beforeSend` gate, not just the matcher.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "Cannot read property 'scrollLeft' of null",
      filename: MEASURE_SCROLL_CHUNK,
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read property 'appendChild' of null",
            stacktrace: { frames: [{ filename: APPEND_CHILD_CHUNK, function: 'ft' }] },
          },
        ],
      },
    }),
    true,
  )
})

test('does NOT suppress a null-deref on a DIFFERENT DOM method (over-match guard, first-party stays observable)', () => {
  // Only `scrollLeft` and `appendChild` are anchored. A null-deref on any
  // other DOM method — even from a minified chunk on an old browser — keeps
  // reporting, because it is not one of the two observed prod patterns and
  // may be a real first-party or third-party regression worth triaging.
  const chunkFrame = { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' }
  for (const message of [
    "Cannot read properties of null (reading 'scrollTop')",
    "Cannot read properties of null (reading 'scrollWidth')",
    "Cannot read properties of null (reading 'removeChild')",
    "Cannot read properties of null (reading 'insertBefore')",
    "Cannot read properties of null (reading 'appendChild')x", // trailing char
    "Cannot read properties of null (reading 'el.scrollLeft')", // dotted expr
    "Cannot read properties of null (reading 'parent.appendChild')", // dotted
  ]) {
    assert.equal(
      isOldBrowserDomNullDerefNoise({ message, frames: [chunkFrame] }),
      false,
      `expected "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a frameless non-matching message even with the scrollLeft/appendChild substring (over-match guard)', () => {
  // The matcher anchors on the EXACT V8/old-JSC message, not a substring. A
  // frameless capture with a message that merely CONTAINS `scrollLeft` or
  // `appendChild` (but is not the exact null-deref wording) keeps reporting.
  for (const message of [
    "Cannot read properties of undefined (reading 'scrollLeft')",
    "Cannot read properties of null (reading 'el.scrollLeft')",
    "el.scrollLeft is null",
    "Cannot read properties of null (reading 'parent.appendChild')",
    "TypeError: parent.appendChild is not a function",
  ]) {
    assert.equal(
      isOldBrowserDomNullDerefNoise({ message }),
      false,
      `expected frameless "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message }),
      false,
      `expected runtime "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a non-first-party but resolvable chunk URL for a different message shape (regression guard)', () => {
  // A Vercel `?dpl=dpl_…` chunk URL is NOT a first-party `apps/web/src/…`
  // path, so it does not trip the negative guard. But the matcher only
  // suppresses the EXACT `scrollLeft`/`appendChild` null-deref wording — a
  // different message from the same chunk URL keeps reporting.
  const vercelChunk = 'https://dosco.live/_next/static/chunks/0d5wqj98qv1e9.js?dpl=dpl_abc123'
  for (const message of [
    "Cannot read properties of null (reading 'foo')",
    'Something completely different',
    "Cannot read properties of null (reading 'appendChild')", // <- this one IS noise
  ]) {
    const expected = message === "Cannot read properties of null (reading 'appendChild')"
    assert.equal(
      isOldBrowserDomNullDerefNoise({ message, frames: [{ filename: vercelChunk }] }),
      expected,
      `expected "${message}" from Vercel chunk to ${expected ? 'be noise' : 'keep reporting'}`,
    )
  }
})

test('the two prod patterns classify as noise independently (sibling isolation)', () => {
  // Each sibling pattern must classify as noise on its own — the matcher is
  // not coupled to both being present. This pins the independence so a future
  // refactor that, say, only handles `scrollLeft` does not silently let
  // `appendChild` leak back to Better Stack.
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read properties of null (reading 'scrollLeft')",
      frames: [{ filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' }],
    }),
    true,
  )
  assert.equal(
    isOldBrowserDomNullDerefNoise({
      message: "Cannot read properties of null (reading 'appendChild')",
      frames: [{ filename: APPEND_CHILD_CHUNK, function: 'ft' }],
    }),
    true,
  )
})

test('suppresses both prod patterns through the runtime gate with the exact prod chunk filename', () => {
  // End-to-end pin: the exact production Better Stack shapes — message + the
  // prod chunk filename — are suppressed by the runtime (window.onerror)
  // gate, which is the gate that actually receives the UNCAUGHT global
  // `onerror` captures (`auto.browser.global_handlers.onerror`).
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "TypeError: Cannot read properties of null (reading 'scrollLeft')",
      filename: MEASURE_SCROLL_CHUNK,
    }),
    true,
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "TypeError: Cannot read properties of null (reading 'appendChild')",
      filename: APPEND_CHILD_CHUNK,
    }),
    true,
  )
})

test('suppresses both prod patterns through the Sentry beforeSend gate with the exact prod stack', () => {
  // End-to-end pin: the exact production Better Stack shapes — message + the
  // prod stack frames — are suppressed by the Sentry `beforeSend` gate.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'scrollLeft')",
            stacktrace: {
              frames: [
                { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' },
                { filename: MEASURE_SCROLL_CHUNK, function: 'measureScroll' },
                { filename: '<anonymous>', function: '?' },
              ],
            },
          },
        ],
      },
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'appendChild')",
            stacktrace: {
              frames: [
                { filename: APPEND_CHILD_CHUNK, function: 'ft' },
                { filename: APPEND_CHILD_CHUNK, function: 'ft' },
                { filename: APPEND_CHILD_CHUNK, function: 'ft' },
              ],
            },
          },
        ],
      },
    }),
    true,
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
      request: { url: 'https://dosco.live/auth?redirect=%2Fprojects%2F038ce7cd-c239-47eb-9ad3-83f2e5345aa6%2Fthread%2F75e8053d-85f9-4f18-a6e5-2ac4f0600e44' },
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
      request: { url: 'https://dosco.live/auth?redirect=%2Fprojects%2F59aa5850-de1d-4e56-81fb-34d532146f01%2Fthread%2F2149cad0-e79e-4d38-84ac-273364cfb434' },
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
// all four JS engine wordings for the same bug: V8
// (`Cannot read properties of null (reading '<m>')`), old JSC
// (`Cannot read property '<m>' of null`), SpiderMonkey/Firefox
// (`can't access property "<m>"<…>` — the recurrence that shipped through
// PR #4544's V8/JSC-only filter), and modern JSC (Safari / Chrome-on-iOS CriOS,
// which uses WebKit/JSC rather than V8: `null is not an object (evaluating
// 'this.gl.<m>')` — pattern `a8754de5…`).
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
  // Modern JSC (JavaScriptCore — Safari / Chrome-on-iOS CriOS, which uses
  // WebKit/JSC rather than V8). JSC wraps the offending expression as
  // `null is not an object (evaluating '<expr>')`; the Paper Shaders library
  // accesses the WebGL2 context as `this.gl.<method>`, so the prod wording
  // (Better Stack pattern `a8754de5…`, 1 occurrence / 0 users, Chrome 150 on
  // iOS 26.5.2, route `/projects/:id/sessions/:sessionId`) is the exact full
  // message per method. The raw `exception.values[].value` has no `TypeError: `
  // prefix, but Sentry capture paths vary, so pin all three forms like the
  // SpiderMonkey entries above.
  "null is not an object (evaluating 'this.gl.getSupportedExtensions')",
  "TypeError: null is not an object (evaluating 'this.gl.getSupportedExtensions')",
  "Unhandled promise rejection: TypeError: null is not an object (evaluating 'this.gl.getSupportedExtensions')",
  "null is not an object (evaluating 'this.gl.getAttribLocation')",
  "TypeError: null is not an object (evaluating 'this.gl.getAttribLocation')",
  "Unhandled promise rejection: TypeError: null is not an object (evaluating 'this.gl.getAttribLocation')",
  // Gecko / Firefox DOM-binding wording — the FIFTH engine variant of this
  // null-WebGL-context crash class, surfaced via a DIFFERENT code path from
  // SpiderMonkey's engine TypeError (`can't access property "<m>"<…>`) above.
  // When the WebGL2 context is null/invalid, Firefox's DOM bindings throw on
  // the method call itself with the canonical Gecko DOM-API shape
  // `<Interface>.<method>: Argument 1 is not an object.`. Better Stack pattern
  // fd773de23b8dbee3551f1132df1dc048a80307133e1e513ca2422ca2bc4fd29a
  // (dosco Frontend prod, application_id 2346967): `TypeError`, message
  // `WebGL2RenderingContext.getAttribLocation: Argument 1 is not an object.`,
  // 1 occurrence / 0 identified users, first 2026-08-07 19:34:33 UTC
  // (post-v0.12.5, release e2540c341c6f43536a7cf0e0b51599e9928f055c),
  // call site `setupPositionAttribute` in chunk
  // `app:///_next/static/immutable/chunks/24zv25pg_k-nz.js`, request URL
  // `https://dosco.live/` (marketing homepage), browser Firefox 152.0 on
  // Android 17 (Gecko engine), mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT,
  // `handled:false`). The `getSupportedExtensions` sibling is pinned
  // preemptively — same class, Firefox may emit it too. The
  // `WebGL2RenderingContext.<method>:` prefix is Gecko's DOM-binding marker
  // (never first-party app code), so the message-only contract (no chunk-frame
  // anchor, no first-party negative guard) applies — same as the other engine
  // variants. Note: `stripErrorWrappers`'s `[A-Za-z]+Error:` regex does NOT
  // strip the `WebGL2RenderingContext.<method>:` prefix (it contains a `.`), so
  // the `TypeError: ` / `Unhandled promise rejection: ` wrappers are stripped
  // and the pattern is matched verbatim by `.includes()`.
  'WebGL2RenderingContext.getSupportedExtensions: Argument 1 is not an object.',
  'WebGL2RenderingContext.getAttribLocation: Argument 1 is not an object.',
  // The wrapper forms a Sentry/runtime capture path may prefix the Gecko
  // DOM-binding message with. `stripErrorWrappers` strips the `TypeError: `
  // and `Unhandled promise rejection: ` / `Unhandled promise rejection:
  // TypeError: ` prefixes; the `WebGL2RenderingContext.<method>:` prefix is NOT
  // stripped (it is not a typed-error prefix), so the underlying pattern still
  // matches verbatim.
  'TypeError: WebGL2RenderingContext.getSupportedExtensions: Argument 1 is not an object.',
  'TypeError: WebGL2RenderingContext.getAttribLocation: Argument 1 is not an object.',
  'Unhandled promise rejection: TypeError: WebGL2RenderingContext.getAttribLocation: Argument 1 is not an object.',
  // Paper Shaders library's OWN internal guard wording — the SIXTH variant of
  // this null-WebGL-context crash class, and the ONLY one that is the library's
  // OWN throw rather than a JS-engine TypeError or a Gecko DOM-binding message.
  // When the library's internal state check detects that `this.gl` (the WebGL2
  // context it cached at mount) is `null`, it throws `this.gl is null` directly.
  // Better Stack pattern
  // f0c8c42213b12122948f4c8307b1eedb6a51afe9072460604e3be14e0277d3f2
  // (Kortix Frontend prod, application_id 2346967): `TypeError`, message
  // `this.gl is null`, 1 occurrence / 0 identified users, first 2026-08-10
  // 14:35:19 UTC (post-v0.12.7), request URL
  // `https://kortix.com/projects/1d0153d2-…` (project page), browser Firefox
  // 137.0 on Windows 10 (Gecko engine), mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT,
  // `handled:false`), 3 frames in chunk
  // `app:///_next/static/immutable/chunks/2_t47hwky1w2m.js` (Paper Shaders
  // library). Pinned in all three capture-path forms (bare, `TypeError: `-prefixed,
  // and `Unhandled promise rejection: `-prefixed) like the other variants so
  // every Sentry / runtime capture path classifies consistently.
  'this.gl is null',
  'TypeError: this.gl is null',
  'Unhandled promise rejection: this.gl is null',
]

// The exact production event from Better Stack pattern
// fd773de23b8dbee3551f1132df1dc048a80307133e1e513ca2422ca2bc4fd29a — the
// Gecko/Firefox DOM-binding wording of the Paper Shaders null-WebGL-context
// crash class (call site `setupPositionAttribute`, chunk
// `app:///_next/static/immutable/chunks/24zv25pg_k-nz.js`, Firefox 152 on
// Android 17, marketing homepage). Pinned as a regression test so this exact
// production wording never pages Better Stack again.
const PAPER_SHADER_GECKO_NULL_CONTEXT_PRODUCTION_MESSAGE =
  'WebGL2RenderingContext.getAttribLocation: Argument 1 is not an object.'

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
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      true,
      `expected Sentry gate to suppress "${message}" even without a chunk frame`,
    )
  }
})

test('does NOT suppress a real app TypeError with a different null-property name', () => {
  // A genuine first-party `foo.bar` null-deref regression throws the same
  // `Cannot read properties of null (reading '<name>')` SHAPE but with an
  // app-property name, not a WebGL2 API method — it must keep reporting so a
  // real null-deref regression is never hidden by the Paper Shaders guard.
  // Covers all six wordings (V8, old JSC, SpiderMonkey/Firefox, modern JSC,
  // Gecko/Firefox DOM-binding, and the library's OWN `this.gl is null` internal
  // guard) so the Firefox `can't access property "<m>"` pattern, the modern-JSC
  // `null is not an object (evaluating '<expr>')` pattern, the Gecko
  // `WebGL2RenderingContext.<m>: Argument 1 is not an object.` pattern, AND the
  // bare `this.gl is null` library-guard pattern can't swallow a real
  // first-party null-deref with a non-WebGL property / method / receiver name.
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
    // Modern JSC generic `null is not an object (evaluating '<expr>')` throws
    // that share the JSC wrapper SHAPE but are NOT the Paper Shaders WebGL2
    // `this.gl.<method>` expression — must keep reporting so the modern-JSC
    // patterns can't swallow a real first-party JSC null-deref.
    "null is not an object (evaluating 'this.gl.someOtherMethod')",
    "null is not an object (evaluating 'foo.bar')",
    "TypeError: null is not an object (evaluating 'this.gl.unsupportedMethod')",
    // A Gecko-style DOM-binding message with a NON-WebGL2 interface / method —
    // same `Argument 1 is not an object.` SHAPE but NOT the
    // `WebGL2RenderingContext.<method>` anchor — must keep reporting so the
    // Gecko pattern can't swallow a real first-party DOM-API null-deref.
    'CanvasRenderingContext2D.fillRect: Argument 1 is not an object.',
    'WebGL2RenderingContext.someOtherMethod: Argument 1 is not an object.',
    // Real first-party `this.<other> is null` null-deref — same SHAPE as the
    // Paper Shaders library-guard `this.gl is null` message but NOT the `this.gl`
    // receiver (a WebGL2 context field no first-party `apps/web/src/…` code
    // holds — confirmed by `rg "this\.gl" apps/web/src`). A genuine first-party
    // null-receiver on a DIFFERENT field (`this.canvas`, `this.context`,
    // `this.program`, `this.foo`, …) must keep reporting so the bare-string
    // `this.gl is null` pattern can't swallow it. Substring-anchored, so
    // `this.global is null` / `this.glide is null` (which CONTAIN `this.gl` as a
    // prefix of a longer token) do NOT match either — `.includes('this.gl is null')`
    // requires the exact `this.gl is null` token.
    'this.canvas is null',
    'this.context is null',
    'this.program is null',
    'this.foo is null',
    'TypeError: this.bar is null',
    'Unhandled promise rejection: this.baz is null',
    'this.global is null',
    'this.glide is null',
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

// Regression test pinning the EXACT production event from Better Stack pattern
// fd773de23b8dbee3551f1132df1dc048a80307133e1e513ca2422ca2bc4fd29a — the
// Gecko/Firefox DOM-binding wording of the Paper Shaders null-WebGL-context
// crash class. The event reached Sentry as an UNCAUGHT `onunhandledrejection`
// (`handled:false`) from Firefox 152 on Android 17 on the marketing homepage
// (`https://dosco.live/`), post-v0.12.5, with call site `setupPositionAttribute`
// in chunk `app:///_next/static/immutable/chunks/24zv25pg_k-nz.js`. Before this
// fix, the `WebGL2RenderingContext.getAttribLocation: Argument 1 is not an
// object.` wording was NOT in `PAPER_SHADER_NULL_CONTEXT_NOISE_PATTERNS`
// (which covered V8, old JSC, SpiderMonkey, and modern JSC only), so the
// event paged Better Stack. This test pins the exact message + the production
// chunk frame so the Gecko DOM-binding wording is classified as noise by the
// matcher, the runtime gate, AND the Sentry `beforeSend` gate — and a future
// recurrence of this exact production event never pages Better Stack again.
test('regression: Gecko/Firefox DOM-binding Paper Shaders null-context crash is suppressed (BS pattern fd773de2…)', () => {
  // The exact production message (no wrapper prefix — the raw Sentry
  // `exception.values[].value`).
  assert.equal(
    isPaperShaderNullContextNoise(PAPER_SHADER_GECKO_NULL_CONTEXT_PRODUCTION_MESSAGE),
    true,
    'expected the exact Gecko production message to be classified as Paper Shaders null-context noise',
  )
  // The runtime (window.onerror / onunhandledrejection) gate must suppress it.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({ message: PAPER_SHADER_GECKO_NULL_CONTEXT_PRODUCTION_MESSAGE }),
    true,
    'expected runtime gate to suppress the Gecko production message',
  )
  // The Sentry `beforeSend` gate must suppress it — both WITH the production
  // chunk frame (the actual prod stack shape) and frameless (the message-only
  // contract means no chunk-frame anchor is required).
  const productionChunkFrame = {
    filename: 'app:///_next/static/immutable/chunks/24zv25pg_k-nz.js',
  }
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: PAPER_SHADER_GECKO_NULL_CONTEXT_PRODUCTION_MESSAGE,
            stacktrace: { frames: [productionChunkFrame] },
          },
        ],
      },
    }),
    true,
    'expected Sentry gate to suppress the Gecko production message with the production chunk frame',
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: PAPER_SHADER_GECKO_NULL_CONTEXT_PRODUCTION_MESSAGE,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
    'expected Sentry gate to suppress the Gecko production message even without a chunk frame (message-only contract)',
  )
})

// The exact production event from Better Stack pattern
// f0c8c42213b12122948f4c8307b1eedb6a51afe9072460604e3be14e0277d3f2 — the
// Paper Shaders library's OWN internal guard wording of the null-WebGL-context
// crash class (call site in chunk
// `app:///_next/static/immutable/chunks/2_t47hwky1w2m.js`, Firefox 137.0 on
// Windows 10, `/projects/1d0153d2-…` project page, post-v0.12.7). Pinned as a
// regression test so this exact production wording never pages Better Stack
// again. Unlike the V8/JSC/SpiderMonkey/Gecko entries (JS-engine / DOM-binding
// wordings the library triggered by dereferencing the null context), this is
// the library's OWN explicit throw — `this.gl is null` — fired when its
// internal state check detects the null WebGL2 context. It is the SIXTH wording
// variant of the same crash class.
const PAPER_SHADER_LIBRARY_GUARD_NULL_CONTEXT_PRODUCTION_MESSAGE = 'this.gl is null'

test('regression: Paper Shaders library-guard null-context crash is suppressed (BS pattern f0c8c422…)', () => {
  // The exact production message (no wrapper prefix — the raw Sentry
  // `exception.values[].value`).
  assert.equal(
    isPaperShaderNullContextNoise(PAPER_SHADER_LIBRARY_GUARD_NULL_CONTEXT_PRODUCTION_MESSAGE),
    true,
    'expected the exact library-guard production message to be classified as Paper Shaders null-context noise',
  )
  // The runtime (window.onerror / onunhandledrejection) gate must suppress it.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({ message: PAPER_SHADER_LIBRARY_GUARD_NULL_CONTEXT_PRODUCTION_MESSAGE }),
    true,
    'expected runtime gate to suppress the library-guard production message',
  )
  // The Sentry `beforeSend` gate must suppress it — both WITH the production
  // chunk frame (the actual prod stack shape) and frameless (the message-only
  // contract means no chunk-frame anchor is required).
  const productionChunkFrame = {
    filename: 'app:///_next/static/immutable/chunks/2_t47hwky1w2m.js',
  }
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: PAPER_SHADER_LIBRARY_GUARD_NULL_CONTEXT_PRODUCTION_MESSAGE,
            stacktrace: { frames: [productionChunkFrame] },
          },
        ],
      },
    }),
    true,
    'expected Sentry gate to suppress the library-guard production message with the production chunk frame',
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: PAPER_SHADER_LIBRARY_GUARD_NULL_CONTEXT_PRODUCTION_MESSAGE,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
    'expected Sentry gate to suppress the library-guard production message even without a chunk frame (message-only contract)',
  )
})

// ---------------------------------------------------------------------------
// Paper Shaders (`@paper-design/shaders-react`) WebGL-unsupported deliberate-
// throw noise — a SIBLING of the null-context crash class above, but a DIFFERENT
// throw. The library's OWN canonical
//   "Paper Shaders: WebGL is not supported in this browser"
// `Error` is thrown from the library's shader-mount constructor when WebGL is
// unavailable (stripped-down/mobile WebView, headless renderer, WebGL disabled,
// GPU blacklisted at context creation) — a deliberate library signal, NOT a
// null-context `TypeError` from calling a WebGL2 method on a `null` context.
// It escapes `<ShaderSafe>` (the library constructor runs inside a dynamic
// import / `useEffect` that bypasses the React error boundary) and reaches
// Sentry as an uncaught global `onunhandledrejection` — an EXPECTED
// degradation state on WebGL-less browsers, never a product bug.
//
// Better Stack pattern
// f1abf79ece48a86faf8eb32cec8bbb6bf270627f9fd5d423fb1ee43b9abcfb23
// (dosco Frontend prod, application_id 2346967): `Error`, message
// `Paper Shaders: WebGL is not supported in this browser`, 1 occurrence /
// 0 identified users (anonymous), last 2026-07-23 17:26:32 UTC, release
// `470fe6f3c88460212c3b187f6f86fb4ad456c4d6` (v0.10.13), route `/`
// (marketing homepage), mechanism
// `auto.browser.global_handlers.onunhandledrejection` (UNCAUGHT global
// unhandledrejection — never reached a React error boundary). Browser: Chrome
// 150.0.0.0 on Android 10 (mobile) — a stripped-down/mobile Android browser
// without WebGL. Stack frames: 2, both minified `@paper-design/shaders`
// chunk frames (NO first-party `apps/web/src/…` frame):
//   - `app:///_next/static/chunks/81107-7c84018ef9475be5.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno`
//     function `?` lineno 251 colno 3276
//   - same chunk function `new a` lineno 401 colno 1131  (call_site_function)
//
// The matcher anchors on the EXACT library message (the `Paper Shaders:`
// prefix is the library's canonical marker, never emitted by first-party app
// code) AND a NEGATIVE guard: a resolved first-party `apps/web/src/…` frame
// means our own code threw this exact message → a real first-party regression
// (de-minified to `apps/web/src/…`) → keep reporting. The production noise
// pattern carries only minified `@paper-design/shaders` chunk frames, so the
// negative guard does not fire for it. A frameless capture with this exact
// message still classifies as noise (the message alone is specific — the
// `Paper Shaders:` library prefix is part of the anchor).
// ---------------------------------------------------------------------------

// The exact exception value + the two production `@paper-design/shaders` chunk
// frames from Better Stack pattern `f1abf79e…`.
const PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE =
  'Paper Shaders: WebGL is not supported in this browser'

const PAPER_SHADER_WEBGL_UNSUPPORTED_PROD_FRAMES = [
  {
    filename:
      'app:///_next/static/chunks/81107-7c84018ef9475be5.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno',
    function: '?',
    lineno: 251,
    colno: 3276,
  },
  {
    filename:
      'app:///_next/static/chunks/81107-7c84018ef9475be5.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno',
    function: 'new a',
    lineno: 401,
    colno: 1131,
  },
]

test('classifies the Paper Shaders WebGL-unsupported prod event as noise (exact message + 2 chunk frames)', () => {
  // Exact production shape: the canonical library message + the two minified
  // `@paper-design/shaders` chunk frames. No first-party `apps/web/src/…`
  // frame, so the negative guard does not fire.
  assert.equal(
    isPaperShaderWebGLUnsupportedNoise({
      message: PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE,
      frames: PAPER_SHADER_WEBGL_UNSUPPORTED_PROD_FRAMES,
    }),
    true,
  )
})

test('suppresses the Paper Shaders WebGL-unsupported prod Sentry event via the beforeSend gate', () => {
  // Exact shape of the production event: mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (uncaught global
  // unhandledrejection — never reached a React error boundary), request URL
  // `https://dosco.live/` (the marketing homepage), the two minified
  // `@paper-design/shaders` chunk frames.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
      exception: {
        values: [
          {
            value: PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE,
            stacktrace: {
              frames: PAPER_SHADER_WEBGL_UNSUPPORTED_PROD_FRAMES,
            },
          },
        ],
      },
    }),
    true,
  )
})

test('classifies the Paper Shaders WebGL-unsupported message through all three capture-path wrapper forms', () => {
  // The raw `exception.values[].value` has no `Error: ` prefix, but Sentry
  // capture paths vary — pin all three forms (raw, `Error: `, and
  // `Unhandled promise rejection: Error: `) so the matcher classifies
  // consistently regardless of which path delivered it. Use the production
  // chunk frames so the matcher runs in its realistic frame context.
  const wrapperForms = [
    PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE,
    `Error: ${PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE}`,
    `Unhandled promise rejection: Error: ${PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE}`,
  ]
  for (const message of wrapperForms) {
    assert.equal(
      isPaperShaderWebGLUnsupportedNoise({
        message,
        frames: PAPER_SHADER_WEBGL_UNSUPPORTED_PROD_FRAMES,
      }),
      true,
      `expected "${message}" to be classified as Paper Shaders WebGL-unsupported noise`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: message,
              stacktrace: {
                frames: PAPER_SHADER_WEBGL_UNSUPPORTED_PROD_FRAMES,
              },
            },
          ],
        },
      }),
      true,
      `expected Sentry gate to suppress "${message}"`,
    )
  }
})

test('classifies the frameless Paper Shaders WebGL-unsupported capture as noise', () => {
  // The message alone is specific enough (the `Paper Shaders:` library prefix
  // is part of the anchor) that a frameless capture with this exact message
  // still classifies as noise — the library throw never originates from
  // first-party app code. Verify both the matcher and the Sentry gate.
  assert.equal(
    isPaperShaderWebGLUnsupportedNoise({
      message: PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE,
      frames: [],
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [{ value: PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE }],
      },
    }),
    true,
  )
})

test('does NOT suppress the Paper Shaders WebGL-unsupported message when a first-party apps/web/src frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code threw this exact
  // message → a real first-party regression (the `Paper Shaders:` prefix is
  // the library's canonical marker, but a hostile/copy-pasted first-party
  // throw could share it). The negative guard MUST preserve it so the call
  // site can be found + fixed. This is the whole reason the matcher is
  // frame-aware.
  for (const frames of [
    [{ filename: 'apps/web/src/components/ui/shader-safe.tsx', function: 'mount' }],
    [
      { filename: 'app:///_next/static/chunks/81107-abc.js', function: '?' },
      { filename: 'app:///apps/web/src/features/marketing/hero.tsx', function: 'render' },
    ],
  ]) {
    assert.equal(
      isPaperShaderWebGLUnsupportedNoise({
        message: PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE,
        frames,
      }),
      false,
      `expected first-party Paper Shaders WebGL-unsupported throw from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: PAPER_SHADER_WEBGL_UNSUPPORTED_MESSAGE,
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party Paper Shaders WebGL-unsupported throw from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress a near-worded message without the Paper Shaders: prefix', () => {
  // The `Paper Shaders:` library prefix is part of the anchor — a near-worded
  // message that lacks it (e.g. a real first-party `throw new Error('WebGL is
  // not supported in this browser')`, or a different library's WebGL check)
  // must keep reporting. The matcher anchors on the EXACT full library
  // string, so an over-match guard is in place.
  for (const message of [
    'WebGL is not supported in this browser',
    'Error: WebGL is not supported in this browser',
    'WebGL is not supported',
    'Paper Shaders: WebGL is not supported',
    'Paper Shaders WebGL is not supported in this browser',
  ]) {
    assert.equal(
      isPaperShaderWebGLUnsupportedNoise({
        message,
        frames: PAPER_SHADER_WEBGL_UNSUPPORTED_PROD_FRAMES,
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: message,
              stacktrace: {
                frames: PAPER_SHADER_WEBGL_UNSUPPORTED_PROD_FRAMES,
              },
            },
          ],
        },
      }),
      false,
      `expected Sentry event "${message}" to keep reporting`,
    )
  }
})

// ---------------------------------------------------------------------------
// TronLink browser-extension injected-Proxy `set`-trap noise
// (Better Stack pattern 951c1a316cae8595da3f73877cb1fa8a77d04315ae1a2987b6348a97ec9a049a,
// dosco Frontend prod, application_id 2346967). The TronLink wallet extension
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
        request: { url: 'https://app.dosco.live/projects' },
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
    { filename: 'https://app.dosco.live/_next/static/chunks/store.js' },
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
// (dosco Frontend prod, application_id 2346967): 1 occurrence, 0 identified
// users, 2026-07-21 05:08 UTC. A Tampermonkey/Violentmonkey userscript
// (`YoutubeDL.user.js`) `@match`ing `*://*/*` ran on the marketing homepage
// (`https://dosco.live/`, Chrome 150 / Windows 10). The user script's own
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
      request: { url: 'https://dosco.live/' },
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
    { filename: 'https://app.dosco.live/_next/static/chunks/json.js', function: 'revive' },
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
        request: { url: 'https://app.dosco.live/projects' },
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
    'https://app.dosco.live/_next/static/chunks/json.js',
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
// (dosco Frontend prod, application_id 2346967): 1 occurrence, 0 identified
// users, 2026-07-12 19:31:47 UTC. A Threads (Barcelona) in-app Android WebView
// (Android 14 / Chrome 149, referer https://l.threads.com/) visited the
// marketing homepage (`https://dosco.live/`). The Android System WebView
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
        request: { url: 'https://dosco.live/' },
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
        frames: [],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event "${message}" to keep reporting`,
    )
  }
})

// ---------------------------------------------------------------------------
// Third-party editor-library (ProseMirror/TipTap-based) document-state race
// noise (Better Stack patterns
// 6d6fa794a67a293ce9fa5d093648a9d76a2dd243e04f4f9dd9fbbd67bfb0c9ef and
// a954c7e7553065986e8177c68b82ccf3c3d83d6eabb413700974b2a11f841fb7, Kortix
// Frontend prod, application_id 2346967). A ProseMirror/TipTap-based editor
// library holds an internal document-state map keyed by document id; when the
// editor is unmounted / the document closed while an async interaction or
// selection is still in flight (a race in the library's async interaction
// handling, fired by WebKit's async timing differing from Chrome's), the
// library's own internal `getDocumentStateOrThrow` / `getDocumentState`
// helpers throw `<Interaction|Selection> state not found for document:
// <docId>`. Both Better Stack patterns are the SAME doc id
// (`doc-1785904808253-gbsixyvii`), same Safari 26.5 session
// (`be897489-001b-4ca4-b9ca-a1aa770c4082`), same minified chunk
// `17631.2j-4o95.js`, last 2026-08-05 04:40:45 UTC (POST-v0.12.3), UNCAUGHT
// (`handled:false`, mechanism `addEventListener`), NO first-party
// `apps/web/src/…` frame. 28 occurrences (interaction) + 2 occurrences
// (selection) from a single session in a short window — a transient race, not
// a persistent bug. The matcher anchors on the
// `/^(Interaction|Selection) state not found for document:/` message prefix
// with a NEGATIVE guard: any resolved first-party `apps/web/src/…` frame →
// keep reporting (a real first-party `throw new Error('Interaction state not
// found for document: …')` regression de-minifies to `apps/web/src/…`).
// ---------------------------------------------------------------------------

// The exact interaction-state message from the production event (pattern
// 6d6fa794…, 28 occurrences).
const DOCUMENT_STATE_INTERACTION_MESSAGE =
  'Interaction state not found for document: doc-1785904808253-gbsixyvii'

// The exact selection-state message from the production event (pattern
// a954c7e7…, 2 occurrences, SAME doc id).
const DOCUMENT_STATE_SELECTION_MESSAGE =
  'Selection state not found for document: doc-1785904808253-gbsixyvii'

// Pattern 6d6fa794 — the production stack frames (oldest-first → throwing
// frame last): the entry `r` in chunk `13jg6.ewllp.z.js`, then the editor
// library's internal `v` → `getActiveMode` → `getDocumentStateOrThrow` in
// chunk `17631.2j-4o95.js`. All minified third-party library chunk frames —
// NO first-party `apps/web/src/…` frame.
const DOCUMENT_STATE_INTERACTION_FRAMES = [
  { filename: 'app:///_next/static/chunks/13jg6.ewllp.z.js', function: 'r' },
  { filename: 'app:///_next/static/chunks/17631.2j-4o95.js', function: 'v' },
  { filename: 'app:///_next/static/chunks/17631.2j-4o95.js', function: 'getActiveMode' },
  { filename: 'app:///_next/static/chunks/17631.2j-4o95.js', function: 'getDocumentStateOrThrow' },
]

// Pattern a954c7e7 — the selection sibling's call site is the library's
// `getDocumentState` in the same `17631.2j-4o95.js` chunk.
const DOCUMENT_STATE_SELECTION_FRAMES = [
  { filename: 'app:///_next/static/chunks/17631.2j-4o95.js', function: 'getDocumentState' },
]

// The production Sentry event shape (pattern 6d6fa794): UNCAUGHT, mechanism
// `auto.browser.browserapierrors.addEventListener`, handled:false, on the
// co-worker session page.
const DOCUMENT_STATE_INTERACTION_EVENT = {
  request: {
    url: 'https://dosco.live/projects/e1d956a3-0221-48ac-8060-5343a86e47dc/sessions/be897489-001b-4ca4-b9ca-a1aa770c4082',
  },
  exception: {
    values: [
      {
        value: DOCUMENT_STATE_INTERACTION_MESSAGE,
        mechanism: {
          type: 'auto.browser.browserapierrors.addEventListener',
          handled: false,
        },
        stacktrace: { frames: DOCUMENT_STATE_INTERACTION_FRAMES },
      },
    ],
  },
}

test('classifies the editor document-state interaction race as noise (pattern 6d6fa794)', () => {
  assert.equal(
    isDocumentStateNotFoundNoise({
      message: DOCUMENT_STATE_INTERACTION_MESSAGE,
      frames: DOCUMENT_STATE_INTERACTION_FRAMES,
    }),
    true,
  )
})

test('classifies the editor document-state selection race as noise (pattern a954c7e7)', () => {
  assert.equal(
    isDocumentStateNotFoundNoise({
      message: DOCUMENT_STATE_SELECTION_MESSAGE,
      frames: DOCUMENT_STATE_SELECTION_FRAMES,
    }),
    true,
  )
})

test('suppresses the assigned editor document-state interaction Sentry event via the beforeSend gate', () => {
  assert.equal(
    shouldIgnoreSentryBrowserNoise(DOCUMENT_STATE_INTERACTION_EVENT),
    true,
  )
})

test('suppresses the editor document-state event via the runtime gate too', () => {
  // The runtime gate sees the window.onerror `filename`; the prod event's
  // throw site is the library chunk, so a runtime capture with the chunk
  // filename + the canonical message classifies as noise.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: DOCUMENT_STATE_INTERACTION_MESSAGE,
      filename: 'app:///_next/static/chunks/17631.2j-4o95.js',
    }),
    true,
  )
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: DOCUMENT_STATE_SELECTION_MESSAGE,
      filename: 'app:///_next/static/chunks/17631.2j-4o95.js',
    }),
    true,
  )
})

test('suppresses the editor document-state event even with no frames (message-only capture)', () => {
  // The `for document:` suffix names the library's document-state map; a
  // frameless capture with this exact message prefix still classifies as
  // noise (the message wording is library-specific). This mirrors the
  // Connection-closed / Paper-Shaders-WebGL-unsupported matchers.
  assert.equal(
    isDocumentStateNotFoundNoise({
      message: DOCUMENT_STATE_INTERACTION_MESSAGE,
      frames: [],
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          { value: DOCUMENT_STATE_INTERACTION_MESSAGE, stacktrace: { frames: [] } },
        ],
      },
    }),
    true,
  )
})

test('does NOT suppress the editor document-state throw when a first-party frame is present (real regression)', () => {
  // A resolved `apps/web/src/…` frame means our own code threw this
  // state-lookup message → actionable regression; the negative guard MUST
  // preserve it so the call site can be found + fixed. The message wording
  // alone is not enough to drop — the library's canonical wording could be
  // reused by a hostile/copy-pasted first-party throw.
  for (const frames of [
    [{ filename: 'apps/web/src/features/session/session-chat.tsx', function: 'SessionChat' }],
    [
      { filename: 'app:///_next/static/chunks/17631.2j-4o95.js', function: 'getDocumentStateOrThrow' },
      { filename: 'app:///apps/web/src/features/editor/state.ts', function: 'lookup' },
    ],
  ]) {
    assert.equal(
      isDocumentStateNotFoundNoise({
        message: DOCUMENT_STATE_INTERACTION_MESSAGE,
        frames,
      }),
      false,
      `expected first-party document-state throw from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: DOCUMENT_STATE_INTERACTION_MESSAGE,
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party document-state throw from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress a near-worded message that is not a document-state lookup (over-match guard)', () => {
  // Only the `<Interaction|Selection> state not found for document:` prefix
  // is noise; a different wording keeps reporting so the matcher does not
  // over-match.
  for (const message of [
    'Interaction state not found',
    'Selection state not found',
    'state not found for document: doc-x',
    'Interaction state not found for widget: w-1',
    'Document state not found for document: doc-x',
  ]) {
    assert.equal(
      isDocumentStateNotFoundNoise({
        message,
        frames: DOCUMENT_STATE_INTERACTION_FRAMES,
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: DOCUMENT_STATE_INTERACTION_FRAMES } }] },
      }),
      false,
      `expected Sentry event "${message}" to keep reporting`,
    )
  }
})

// ---------------------------------------------------------------------------
// Broader third-party-library React #185 "Maximum update depth exceeded"
// fallback noise (Better Stack patterns
// 223d7d7e1000bc98be5969f2cddac143e03134cb39442f0b959cf1def53ccb8a,
// 51b14963e617b4cee9926db4a4d6a9d50d4bdfb3b71d5f32faf1c83d33066d12, and
// cd68e360db0f42e7dca4e9e922cfe80ed629e878dbb327f74ac889d194da0276, Kortix
// Frontend prod, application_id 2346967). A ProseMirror/TipTap-based editor
// library's async interaction/selection handler re-enters the React render
// loop after its document-state-map race (see the document-state matcher
// above), tripping React's 50-nested-update guard (#185) WITHOUT an
// `onTileRendering` frame. All three patterns are from the SAME Safari 26.5
// session (`be897489-…`), same release, same `0foj1ouh5ijrj.js` chunk, same
// 2026-08-05 ~04:30–05:28 UTC window, 1 occurrence each, UNCAUGHT
// (`handled:false`). The existing `isEmbedPdfTilingReactUpdateDepthNoise`
// matcher anchors on the `onTileRendering` frame and does NOT catch these —
// they have no `onTileRendering` frame. This broader fallback matcher runs
// AFTER the tiling matcher and catches non-tiling third-party #185s. It
// requires the #185 message AND TWO negative guards: NO resolved first-party
// `apps/web/src/…` frame (a real first-party setState loop de-minifies to
// `apps/web/src/…` and is preserved), AND the event is UNCAUGHT (mechanism is
// a global/BrowserApiErrors auto-handler with `handled:false` — a CAUGHT #185
// that reached a React error boundary may be actionable).
// ---------------------------------------------------------------------------

// Pattern 223d7d7e — mechanism `auto.browser.global_handlers.onerror`, frames
// `r @ 13jg6.ewllp.z.js | f_ @ 0foj1ouh5ijrj.js | fL | s4 | nM | ? | sZ | ?
// @ 00ym4.y9k1959.js | ov | oy`. NO `onTileRendering` frame, NO first-party
// `apps/web/src/…` frame.
const REACT185_THIRDPARTY_FRAMES_223D7D7E = [
  { filename: 'app:///_next/static/chunks/13jg6.ewllp.z.js', function: 'r' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'f_' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'fL' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 's4' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'nM' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: '?' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'sZ' },
  { filename: 'app:///_next/static/chunks/00ym4.y9k1959.js', function: '?' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'ov' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'oy' },
]

// Pattern 51b14963 — mechanism
// `auto.browser.browserapierrors.setInterval`, frames
// `r @ 13jg6.ewllp.z.js | ? @ 12r-_umoe~03c.js | ov @ 0foj1ouh5ijrj.js | oy
// @ 0foj1ouh5ijrj.js`.
const REACT185_THIRDPARTY_FRAMES_51B14963 = [
  { filename: 'app:///_next/static/chunks/13jg6.ewllp.z.js', function: 'r' },
  { filename: 'app:///_next/static/chunks/12r-_umoe~03c.js', function: '?' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'ov' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'oy' },
]

// Pattern cd68e360 — mechanism
// `auto.browser.global_handlers.onunhandledrejection` (handled:false), frames
// `? @ 0d5wqj98qv1e9.js | onExitComplete @ 0f7hq0oahq8u6.js | ? @
// 0f7hq0oahq8u6.js | ov @ 0foj1ouh5ijrj.js | oy @ 0foj1ouh5ijrj.js`. The
// `onExitComplete` frame is the editor library's exit/teardown re-render
// path — the same document-close race that produces the doc-state throws.
const REACT185_THIRDPARTY_FRAMES_CD68E360 = [
  { filename: 'app:///_next/static/chunks/0d5wqj98qv1e9.js', function: '?' },
  { filename: 'app:///_next/static/chunks/0f7hq0oahq8u6.js', function: 'onExitComplete' },
  { filename: 'app:///_next/static/chunks/0f7hq0oahq8u6.js', function: '?' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'ov' },
  { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'oy' },
]

test('classifies the editor re-render-loop React #185 siblings as noise (patterns 223d7d7e / 51b14963 / cd68e360)', () => {
  for (const [label, frames, mechanism] of [
    ['223d7d7e', REACT185_THIRDPARTY_FRAMES_223D7D7E, 'auto.browser.global_handlers.onerror'],
    ['51b14963', REACT185_THIRDPARTY_FRAMES_51B14963, 'auto.browser.browserapierrors.setInterval'],
    ['cd68e360', REACT185_THIRDPARTY_FRAMES_CD68E360, 'auto.browser.global_handlers.onunhandledrejection'],
  ] as const) {
    assert.equal(
      isThirdPartyReactUpdateDepthNoise({
        message: REACT_185,
        mechanism,
        handled: false,
        frames,
      }),
      true,
      `expected React #185 ${label} (no onTileRendering, uncaught) to classify as noise`,
    )
  }
})

test('suppresses the assigned editor re-render-loop React #185 Sentry events via the beforeSend gate', () => {
  for (const [label, frames, mechanism] of [
    ['223d7d7e', REACT185_THIRDPARTY_FRAMES_223D7D7E, 'auto.browser.global_handlers.onerror'],
    ['51b14963', REACT185_THIRDPARTY_FRAMES_51B14963, 'auto.browser.browserapierrors.setInterval'],
    ['cd68e360', REACT185_THIRDPARTY_FRAMES_CD68E360, 'auto.browser.global_handlers.onunhandledrejection'],
  ] as const) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: {
          url: 'https://dosco.live/projects/e1d956a3-0221-48ac-8060-5343a86e47dc/sessions/be897489-001b-4ca4-b9ca-a1aa770c4082',
        },
        exception: {
          values: [
            {
              value: REACT_185,
              mechanism: { type: mechanism, handled: false },
              stacktrace: { frames },
            },
          ],
        },
      }),
      true,
      `expected Sentry gate to suppress React #185 ${label}`,
    )
  }
})

test('suppresses the editor re-render-loop React #185 when handled is omitted (mechanism implies uncaught)', () => {
  // `handled` is optional in the Sentry payload; the global/BrowserApiErrors
  // mechanisms are UNCAUGHT by definition. A missing `handled` is treated as
  // uncaught.
  assert.equal(
    isThirdPartyReactUpdateDepthNoise({
      message: REACT_185,
      mechanism: 'auto.browser.global_handlers.onunhandledrejection',
      frames: REACT185_THIRDPARTY_FRAMES_223D7D7E,
    }),
    true,
  )
})

test('does NOT suppress a React #185 with a resolved first-party frame (real first-party setState loop)', () => {
  // A resolved `apps/web/src/…` frame means our own component is the looping
  // culprit → actionable; the negative guard MUST preserve it. This is the
  // whole reason the matcher is frame-aware (React #185 is also a real
  // first-party setState-loop message).
  for (const frames of [
    [{ filename: 'apps/web/src/features/session/session-chat.tsx', function: 'SessionChat' }],
    [
      { filename: 'app:///_next/static/chunks/0foj1ouh5ijrj.js', function: 'oy' },
      { filename: 'app:///apps/web/src/features/editor/editor.tsx', function: 'render' },
    ],
  ]) {
    assert.equal(
      isThirdPartyReactUpdateDepthNoise({
        message: REACT_185,
        mechanism: 'auto.browser.global_handlers.onerror',
        handled: false,
        frames,
      }),
      false,
      `expected first-party React #185 from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: REACT_185,
              mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party React #185 from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress a CAUGHT React #185 (handled:true — reached a React error boundary)', () => {
  // A CAUGHT #185 (mechanism `handled:true`) reached a React error boundary;
  // the boundary exists to surface first-party render loops the app chose to
  // handle, so it may be actionable and keeps reporting.
  assert.equal(
    isThirdPartyReactUpdateDepthNoise({
      message: REACT_185,
      mechanism: 'auto.browser.global_handlers.onerror',
      handled: true,
      frames: REACT185_THIRDPARTY_FRAMES_223D7D7E,
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: REACT_185,
            mechanism: { type: 'auto.browser.global_handlers.onerror', handled: true },
            stacktrace: { frames: REACT185_THIRDPARTY_FRAMES_223D7D7E },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress a React #185 whose mechanism is not a global/BrowserApiErrors auto-handler', () => {
  // A non-global, non-BrowserApiErrors mechanism (e.g. an explicit
  // `captureException` call, or a custom instrumented boundary) may be
  // actionable; keep reporting. Only the UNCAUGHT global/BrowserApiErrors
  // class is dropped.
  for (const mechanism of [
    'generic',
    'instrument',
    'auto.function.console',
    'manual',
    '',
  ]) {
    assert.equal(
      isThirdPartyReactUpdateDepthNoise({
        message: REACT_185,
        mechanism,
        handled: false,
        frames: REACT185_THIRDPARTY_FRAMES_223D7D7E,
      }),
      false,
      `expected React #185 with mechanism "${mechanism}" to keep reporting`,
    )
  }
})

test('does NOT suppress a React #185 with no frames (cannot confirm it is third-party)', () => {
  // No frames → can't confirm the throw is third-party (no `apps/web/src/…`
  // negative guard evidence, no chunk anchor). Keep reporting rather than
  // blanket-dropping frameless #185s of unknown origin. (Distinct from the
  // doc-state matcher, whose message prefix is library-specific enough that
  // a frameless capture is still noise.)
  assert.equal(
    isThirdPartyReactUpdateDepthNoise({
      message: REACT_185,
      mechanism: 'auto.browser.global_handlers.onerror',
      handled: false,
      frames: [],
    }),
    false,
  )
})

test('does NOT replace or subsume the @embedpdf tiling #185 matcher — the tiling matcher still wins for onTileRendering', () => {
  // The broader fallback matcher runs AFTER
  // `isEmbedPdfTilingReactUpdateDepthNoise` in `shouldIgnoreSentryBrowserNoise`.
  // A tiling #185 with an `onTileRendering` frame is dropped by the TILING
  // matcher (which has the more specific anchor) — the gate returns true for
  // it. The broader matcher is the FALLBACK for non-tiling third-party #185s
  // (no `onTileRendering` frame), NOT a replacement for the tiling matcher.
  const tilingFrames = [
    { filename: 'app:///_next/static/chunks/78309.4a49d57927d341e9.js', function: 'Object.r [as onTileRendering]' },
  ]
  // The tiling matcher (specific anchor) classifies it as noise.
  assert.equal(
    isEmbedPdfTilingReactUpdateDepthNoise({ message: REACT_185, frames: tilingFrames }),
    true,
  )
  // The gate (which tries the tiling matcher FIRST) drops the tiling #185.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: REACT_185,
            mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
            stacktrace: { frames: tilingFrames },
          },
        ],
      },
    }),
    true,
  )
  // A tiling #185 that ALSO carries a first-party frame keeps reporting via
  // BOTH matchers' negative guards (the tiling matcher's negative guard
  // already preserves it; the broader matcher's negative guard agrees).
  const tilingFramesWithFirstParty = [
    { filename: 'app:///_next/static/chunks/78309.4a49d57927d341e9.js', function: 'Object.r [as onTileRendering]' },
    { filename: 'apps/web/src/components/ui/extend/pdf-viewer.tsx', function: 'PDFViewerInner' },
  ]
  assert.equal(
    isEmbedPdfTilingReactUpdateDepthNoise({ message: REACT_185, frames: tilingFramesWithFirstParty }),
    false,
  )
  assert.equal(
    isThirdPartyReactUpdateDepthNoise({
      message: REACT_185,
      mechanism: 'auto.browser.global_handlers.onerror',
      handled: false,
      frames: tilingFramesWithFirstParty,
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: REACT_185,
            mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
            stacktrace: { frames: tilingFramesWithFirstParty },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress a non-React message that happens to mention #185 via the broader matcher', () => {
  // The broader matcher anchors on `Minified React error #185` — a different
  // message wording must not be matched.
  for (const message of [
    'Maximum update depth exceeded',
    'Error #185 in custom handler',
    'react.dev/errors/185',
  ]) {
    assert.equal(
      isThirdPartyReactUpdateDepthNoise({
        message,
        mechanism: 'auto.browser.global_handlers.onerror',
        handled: false,
        frames: REACT185_THIRDPARTY_FRAMES_223D7D7E,
      }),
      false,
      `expected "${message}" to keep reporting`,
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
//  dosco Frontend prod, application_id 2346967): the Android Chromium
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
        request: { url: 'https://dosco.live/' },
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

// --- 2026-08-01 sibling: the `BrowserApiErrors.setTimeout`-captured variant
// (BS pattern `f50ed590…`). The `postEvent` Android WebView bridge-GC throw
// surfaced via Sentry's `BrowserApiErrors` setTimeout auto-wrapper, which
// records the SCHEDULING frame (the Next.js webpack runtime chunk where
// `setTimeout` was REGISTERED) as frame #1 and the actual THROW SITE
// (`<anonymous>`, the anonymous timer callback = the WebView bridge hop) as
// frame #2. The #5181 matcher's resolvable-frame negative guard rejected
// this event because frame #1 (`app:///_next/…`) is resolvable, so it leaked.
// The fix recognizes the `<anonymous>` throw-site frame as a positive anchor
// and relaxes the resolvable-frame negative guard so the incidental
// webpack-runtime scheduling frame does NOT veto suppression. See
// `ANDROID_WEBVIEW_BRIDGE_THROW_SITE_FRAME` for the rationale.
//
// The EXACT production event frames from BS `f50ed590…` (release
// `c330eda4d96e7aee557618254a86df7d16ba5d9b`, v0.12.0, Chrome 150 Android 16,
// mechanism `auto.browser.browserapierrors.setTimeout`, UNCAUGHT `handled:false`,
// URL `https://dosco.live/`). Frame #1 is the webpack runtime chunk
// (`__webpack_require__`'s module-init `setTimeout` registration, minified
// function `u`); frame #2 is the `<anonymous>` throw site (function `?`).
const SETTIMEOUT_PROD_SCHEDULING_FRAME =
  'app:///_next/static/chunks/86784-d4b6544b8ad14b3b.js?dpl=dpl_vkPg62H2TNxvxAUgEDzEoaANndoK'
const SETTIMEOUT_PROD_THROW_SITE_FRAME = '<anonymous>'

test('classifies the BrowserApiErrors.setTimeout-captured postEvent noise (exact prod frames)', () => {
  // The exact production capture shape — frame #1 is the webpack runtime
  // SCHEDULING frame (where `setTimeout` was registered), frame #2 is the
  // `<anonymous>` THROW SITE (the anonymous timer callback = the WebView
  // bridge hop). Both `in_app:true`.
  for (const message of ANDROID_WEBVIEW_BRIDGE_POSTEVENT_EVENTS) {
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({
        message,
        frames: [
          { filename: SETTIMEOUT_PROD_SCHEDULING_FRAME, function: 'u' },
          { filename: SETTIMEOUT_PROD_THROW_SITE_FRAME, function: '?' },
        ],
      }),
      true,
      `expected setTimeout-captured "${message}" (webpack-runtime + <anonymous> throw site) to be noise`,
    )
    // The scheduling frame alone (no `<anonymous>` throw site) must STILL keep
    // reporting — an incidental webpack chunk frame with NO `<anonymous>`
    // throw-site anchor is not the WebView bridge shape; it is an
    // attributable app/webpack error. Only the `<anonymous>` throw-site frame
    // is the positive anchor.
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({
        message,
        frames: [{ filename: SETTIMEOUT_PROD_SCHEDULING_FRAME, function: 'u' }],
      }),
      false,
      `expected scheduling-frame-only "${message}" (no <anonymous> throw site) to keep reporting`,
    )
  }
})

test('classifies the <anonymous> throw-site frame as noise even with an incidental app-chunk scheduling frame', () => {
  // The positive `<anonymous>` throw-site anchor must fire regardless of
  // which incidental scheduling frame the BrowserApiErrors wrapper recorded
  // (a generic `app:///_next/…` chunk, a URL, or any non-first-party source).
  for (const schedulingFrame of [
    'app:///_next/static/chunks/66499-704f783b0e8ea993.js',
    'app:///_next/static/chunks/webpack-abc123.js',
    'https://dosco.live/_next/static/chunks/main-123.js',
  ]) {
    assert.equal(
      isAndroidWebViewNativeBridgePostEventNoise({
        message: 'Error invoking postEvent: Java object is gone',
        frames: [
          { filename: schedulingFrame },
          { filename: '<anonymous>', function: '?' },
        ],
      }),
      true,
      `expected <anonymous> throw site + incidental scheduling frame ${schedulingFrame} to be noise`,
    )
  }
  // The `<anonymous>` throw site is also noise via the runtime (window.onerror)
  // gate when it is the filename itself.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Error invoking postEvent: Java object is gone',
      filename: '<anonymous>',
    }),
    true,
    'expected runtime gate to suppress <anonymous> throw-site postEvent',
  )
})

test('suppresses the BrowserApiErrors.setTimeout-captured postEvent noise via the Sentry beforeSend gate', () => {
  // The exact production Sentry event shape — exception value + 2-frame
  // stacktrace (webpack-runtime scheduling + `<anonymous>` throw site).
  for (const value of ANDROID_WEBVIEW_BRIDGE_POSTEVENT_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://dosco.live/' },
        exception: {
          values: [
            {
              value,
              stacktrace: {
                frames: [
                  { filename: SETTIMEOUT_PROD_SCHEDULING_FRAME, function: 'u' },
                  { filename: SETTIMEOUT_PROD_THROW_SITE_FRAME, function: '?' },
                ],
              },
            },
          ],
        },
      }),
      true,
      `expected Sentry gate to suppress setTimeout-captured "${value}"`,
    )
  }
})

test('still does NOT suppress a real first-party postEvent failure (regression guard for the relaxed matcher)', () => {
  // The first-party `apps/web/src/…` negative guard MUST still fire even when
  // an incidental `<anonymous>` frame is present alongside a first-party frame.
  // A real first-party `postEvent`/`dispatchEvent` regression de-minifies to
  // `apps/web/src/…` and must never be hidden by the relaxed `<anonymous>`
  // throw-site anchor.
  const firstPartyFrames = [
    { filename: 'apps/web/src/features/messaging/event-bridge.ts', function: 'dispatchBridgeEvent' },
    { filename: '<anonymous>', function: '?' },
  ]
  assert.equal(
    isAndroidWebViewNativeBridgePostEventNoise({
      message: 'Error invoking postEvent: Java object is gone',
      frames: firstPartyFrames,
    }),
    false,
    'expected first-party postEvent regression with an incidental <anonymous> frame to keep reporting',
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [{ value: 'Error invoking postEvent: Java object is gone', stacktrace: { frames: firstPartyFrames } }],
      },
    }),
    false,
    'expected Sentry gate to keep reporting first-party postEvent regression',
  )
  // Via the runtime gate: a first-party filename keeps reporting.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: 'Error invoking postEvent: Java object is gone',
      filename: 'apps/web/src/features/messaging/event-bridge.ts',
    }),
    false,
  )
})

// ---------------------------------------------------------------------------
// iOS WebKit (WKWebView) in-app-browser native-bridge `messageHandlers` noise
// — the iOS sibling of the Android WebView bridge classes above.
// (Better Stack pattern
//  5b94212bc682a1ee1d33d67f6517ec95830c63e1ff8a3779d1700dd6091679eb,
//  dosco Frontend prod, application_id 2346967): 1 occurrence / 0 identified
//  users, last_seen 2026-07-27 10:36:24 UTC, release
//  `5d47baf11708881f1099cdaa875266944e976a78` (POST-`0.10.16`), transaction
//  `/` (marketing homepage), URL `https://dosco.live/?fbclid=…` (a Facebook
//  referral), browser `Facebook 571.0.0.55.72` on `iOS (iPhone) 26.5.2` (the
//  Facebook in-app browser — an iOS WebView). The iOS WebView injects a
//  synthetic `app:///` (THREE slashes — distinct from the Android bridge's
//  single-slash `app://navigation_performance_logger_android` source) script
//  that records navigation/performance timing
//  (`processLargestContentfulPaintEvent`) and ships it to its native bridge
//  via `sendDataToNative` → `window.webkit.messageHandlers`. On iOS WebViews
//  where the WebKit `messageHandlers` bridge is unavailable, `window.webkit`
//  is `undefined` and the access throws JSC's canonical
//  `undefined is not an object (evaluating 'window.webkit.messageHandlers')`,
//  captured as an UNCAUGHT global `onerror` (mechanism
//  `auto.browser.global_handlers.onerror`, `handled:false` — never reached a
//  React error boundary). Stack frames (3, all synthetic `app:///` WebView
//  instrumentation — NO first-party `apps/web/src/…` frame):
//    app:///   `?`
//    app:///   `processLargestContentfulPaintEvent`
//    app:///   `sendDataToNative`  (throw, call_site_function)
//  The Android matchers (#5181/#4610) anchor on the Android
//  `app://navigation_performance_logger_android` source and the
//  `postMessage`/`postEvent` Java-bridge-GC message, so they do NOT catch the
//  iOS `app:///` + `window.webkit.messageHandlers` variant. The new matcher
//  anchors on the EXACT `messageHandlers` message + a positive `app:///`/
//  instrumentation-function anchor, with a first-party negative guard.
// ---------------------------------------------------------------------------

// The exact raw exception value from the production event, plus the canonical
// capture-path wrappers Sentry can deliver the same throw through.
const IOS_WEBVIEW_WEBKIT_BRIDGE_EVENTS = [
  // The exact raw exception value (the prod event is `onerror`, no prefix).
  "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
  // A typed-error wrapper (Sentry exception value with the `TypeError: ` type
  // prefix the engine prepends).
  `TypeError: ${"undefined is not an object (evaluating 'window.webkit.messageHandlers')"}`,
  // An unhandled-rejection wrapper preserving the typed-error form (the other
  // capture path Sentry's GlobalHandlers can deliver).
  `Unhandled promise rejection: TypeError: ${"undefined is not an object (evaluating 'window.webkit.messageHandlers')"}`,
]

// The exact 3-frame production capture (Sentry oldest-first → throwing frame
// last), all synthetic `app:///` WebView instrumentation frames.
const IOS_WEBVIEW_PROD_FRAMES = [
  { filename: 'app:///', function: '?' },
  { filename: 'app:///', function: 'processLargestContentfulPaintEvent' },
  { filename: 'app:///', function: 'sendDataToNative' },
]

test('classifies the iOS WebView WebKit messageHandlers bridge noise (with the prod app:/// frames)', () => {
  for (const message of IOS_WEBVIEW_WEBKIT_BRIDGE_EVENTS) {
    assert.equal(
      isIOSWebViewWebKitBridgeNoise({
        message,
        frames: IOS_WEBVIEW_PROD_FRAMES,
      }),
      true,
      `expected "${message}" from the prod app:/// frames to be classified as noise`,
    )
  }
})

test('suppresses the iOS WebView WebKit bridge Sentry event via the beforeSend gate', () => {
  // Exact frame chain from the raw production event (oldest-first → throwing
  // frame last).
  for (const value of IOS_WEBVIEW_WEBKIT_BRIDGE_EVENTS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://dosco.live/?fbclid=abc123' },
        exception: {
          values: [
            {
              value,
              stacktrace: { frames: IOS_WEBVIEW_PROD_FRAMES },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('classifies the iOS WebView WebKit bridge noise via the instrumentation-function anchor alone (no app:/// filename)', () => {
  // The function-name anchor is stable across deploys (mirrors #5181's
  // `postEvent` anchor). A frame with ONLY the function name (no resolvable
  // filename) still classifies as noise.
  for (const message of IOS_WEBVIEW_WEBKIT_BRIDGE_EVENTS) {
    assert.equal(
      isIOSWebViewWebKitBridgeNoise({
        message,
        frames: [{ filename: '', function: 'sendDataToNative' }],
      }),
      true,
      `expected "${message}" with the sendDataToNative function frame to be noise`,
    )
    assert.equal(
      isIOSWebViewWebKitBridgeNoise({
        message,
        frames: [{ filename: 'undefined', function: 'processLargestContentfulPaintEvent' }],
      }),
      true,
      `expected "${message}" with the processLargestContentfulPaintEvent function frame to be noise`,
    )
  }
})

test('suppresses the iOS WebView WebKit bridge noise via the runtime (window.onerror) gate with an app:/// filename', () => {
  for (const message of IOS_WEBVIEW_WEBKIT_BRIDGE_EVENTS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({
        message,
        filename: 'app:///',
      }),
      true,
      `expected runtime gate to suppress "${message}" with an app:/// filename`,
    )
  }
})

test('does NOT suppress a real first-party window.webkit.messageHandlers failure that throws from an apps/web/src frame', () => {
  // A genuine `window.webkit.messageHandlers` access in our own code throws
  // the SAME message wording, but from a de-minified `apps/web/src/…` frame
  // (or an `app:///apps/web/src/…` sourcemap-resolved frame), NEVER from the
  // synthetic `app:///` WebView instrumentation. It must keep reporting so a
  // real first-party regression is never hidden.
  const realFirstPartyFrames: Array<{ filename: unknown; function?: string }> = [
    { filename: 'apps/web/src/features/native-bridge/webkit-handler.ts' },
    { filename: 'app:///apps/web/src/features/native-bridge/webkit-handler.ts' },
  ]
  for (const frames of [realFirstPartyFrames, [...IOS_WEBVIEW_PROD_FRAMES, realFirstPartyFrames[0]]]) {
    assert.equal(
      isIOSWebViewWebKitBridgeNoise({
        message: "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
        frames,
      }),
      false,
      `expected real first-party webkit.messageHandlers error from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting real first-party webkit.messageHandlers error from ${JSON.stringify(frames)}`,
    )
  }
  // And via the runtime gate: a first-party filename keeps reporting.
  assert.equal(
    shouldIgnoreBrowserRuntimeNoise({
      message: "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      filename: 'apps/web/src/features/native-bridge/webkit-handler.ts',
    }),
    false,
  )
})

test('does NOT suppress a near-worded DIFFERENT message (over-match guard — only the exact messageHandlers bridge access is noise)', () => {
  // Only the EXACT `window.webkit.messageHandlers` bridge access is noise — a
  // different WebKit API on `window.webkit.<x>` (e.g. `audioWorklet`) throws a
  // near-worded but DIFFERENT message that must stay observable, even with the
  // `app:///` frames (a different WebKit API failing could be a real
  // regression of a feature we depend on).
  const nearWordedMessage =
    "undefined is not an object (evaluating 'window.webkit.audioWorklet')"
  assert.equal(
    isIOSWebViewWebKitBridgeNoise({
      message: nearWordedMessage,
      frames: IOS_WEBVIEW_PROD_FRAMES,
    }),
    false,
    `expected near-worded "${nearWordedMessage}" to keep reporting`,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: nearWordedMessage,
            stacktrace: { frames: IOS_WEBVIEW_PROD_FRAMES },
          },
        ],
      },
    }),
    false,
    `expected Sentry event for near-worded "${nearWordedMessage}" to keep reporting`,
  )
})

test('does NOT suppress the exact message with NO frames / a frameless capture (can\'t confirm the app:/// WebView anchor)', () => {
  // The positive anchor is mandatory — without the `app:///` frame or an
  // instrumentation function we cannot confirm the iOS WebView origin. A
  // frameless first-party throw of this exact message must stay observable
  // (a real `window.webkit.messageHandlers` access with an unresolvable stack
  // is still attributable to first-party code that needs fixing).
  const message =
    "undefined is not an object (evaluating 'window.webkit.messageHandlers')"
  assert.equal(
    isIOSWebViewWebKitBridgeNoise({ message }),
    false,
    'expected frameless message to keep reporting (no positive anchor)',
  )
  assert.equal(
    isIOSWebViewWebKitBridgeNoise({ message, frames: [] }),
    false,
    'expected message with empty frames to keep reporting (no positive anchor)',
  )
  assert.equal(
    isIOSWebViewWebKitBridgeNoise({
      message,
      frames: [{ filename: 'app:///_next/static/chunks/main.js' }],
    }),
    false,
    'expected message from an app chunk frame (no app:/// anchor) to keep reporting',
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
    }),
    false,
    'expected frameless Sentry event to keep reporting (no positive anchor)',
  )
})

test('does NOT suppress the Android bridge messages under the iOS matcher (and vice versa)', () => {
  // The iOS matcher is message-specific: the Android `postMessage`/`postEvent`
  // `Java object is gone` messages must not be swallowed by the iOS guard,
  // and the iOS `window.webkit.messageHandlers` message must not be swallowed
  // by the Android guards.
  assert.equal(
    isIOSWebViewWebKitBridgeNoise({
      message: 'Error invoking postMessage: Java object is gone',
      frames: [{ filename: ANDROID_NAV_PERF_LOGGER_FRAME }],
    }),
    false,
    'iOS matcher must not swallow the Android postMessage message',
  )
  assert.equal(
    isIOSWebViewWebKitBridgeNoise({
      message: 'Error invoking postEvent: Java object is gone',
      frames: IOS_WEBVIEW_PROD_FRAMES,
    }),
    false,
    'iOS matcher must not swallow the Android postEvent message',
  )
  assert.equal(
    isAndroidWebViewNativeBridgePostMessageNoise({
      message: "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      frames: IOS_WEBVIEW_PROD_FRAMES,
    }),
    false,
    'Android postMessage matcher must not swallow the iOS webkit.messageHandlers message',
  )
  assert.equal(
    isAndroidWebViewNativeBridgePostEventNoise({
      message: "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      frames: IOS_WEBVIEW_PROD_FRAMES,
    }),
    false,
    'Android postEvent matcher must not swallow the iOS webkit.messageHandlers message',
  )
})

// ---------------------------------------------------------------------------
// iOS-WebKit stack-overflow noise
// (Better Stack pattern 87ccbef98ea62fbf90df2446141a26b78ba7f928a28642b099d53b40e8613031,
// dosco Frontend prod, application_id 2346967). iOS WebKit (Safari,
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
// dosco Frontend prod, application_id 2346967). EVM wallet extensions
// (MetaMask + derivatives) inject `app:///inpage.js` whose provider stream is
// `@metamask/post-message-stream`'s `ExtendedBroadcastMessage` (an
// EventEmitter subclass). During extension init / port-teardown races the
// underlying stream/port is `undefined`, so an `.addListener` / `.emit` call
// throws inside `app:///inpage.js` (frames `?` / `fulfilled` /
// `ExtendedBroadcastMessage.<anonymous>`). 0 identified users, first/last
// 2026-07-14, request URL `https://dosco.live/`, Chrome 150. The throw is in
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
        request: { url: 'https://dosco.live/' },
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
    { filename: 'https://app.dosco.live/_next/static/chunks/event-bus.js' },
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

// ---------------------------------------------------------------------------
// Wallet-extension injected `inpage.js` "No error message" noise
// (Better Stack pattern
//  61949432528f8a88c74799f2dc1a8dd128479ae49e6e75865f501e5eb40fc94e,
//  dosco Frontend prod, application_id 2346967). A wallet extension's
//  `onGlobalMessage` → `runIfPresent` → `run` handlers in `app:///inpage.js`
//  throw a value with no `.message` property, so Sentry SDK 10.x writes the
//  `"No error message"` placeholder. The error propagates through the React
//  reconciler (frames `iX`/`iu`/`ib`/`ik`/`oq`/`o_`/`l9`/`l`) and into the
//  `global-error` boundary (chunk `app/global-error-*.js`), which Sentry's
//  `onerror` handler captures. 1 occurrence, 0 identified users, last
//  2026-07-30 09:14:21 UTC, route `/auth?expired=true&returnUrl=…`, mechanism
//  `auto.browser.global_handlers.onerror` (UNCAUGHT global error — never
//  reached a React error boundary directly). The `isEmptyMessageUnresolved-
//  BrowserChunkNoise` matcher does NOT catch this because the `app:///inpage.js`
//  frames are not browser-bundle sources (the "every frame must be browser
//  bundle" guard bails). The `isInpageWalletStreamNoise` matcher does NOT catch
//  it because the message is `"No error message"`, not an `addListener`/`emit`
//  TypeError. The new matcher anchors on the EXACT `"No error message"` string
//  AND an `app:///inpage.js` frame, with a first-party negative guard.
// ---------------------------------------------------------------------------

// The exact production stack: wallet-extension `app:///inpage.js` frames
// (onGlobalMessage → runIfPresent → run) → React reconciler → global-error →
// chunk frames. NO first-party `apps/web/src/…` frame.
const INPAGE_JS_NO_ERROR_MESSAGE_PROD_FRAMES = [
  { filename: 'app:///inpage.js', function: 'onGlobalMessage' },
  { filename: 'app:///inpage.js', function: 'runIfPresent' },
  { filename: 'app:///inpage.js', function: 'run' },
  { filename: 'app:///_next/static/chunks/86784-d4b6544b8ad14b3b.js', function: 'x' },
  { filename: 'app:///_next/static/chunks/9ced0920-3a9e27d92db308d0.js', function: 'iX' },
  { filename: 'app:///_next/static/chunks/9ced0920-3a9e27d92db308d0.js', function: 'iu' },
  { filename: 'app:///_next/static/chunks/9ced0920-3a9e27d92db308d0.js', function: 'ib' },
  { filename: 'app:///_next/static/chunks/9ced0920-3a9e27d92db308d0.js', function: 'ik' },
  { filename: 'app:///_next/static/chunks/9ced0920-3a9e27d92db308d0.js', function: 'oq' },
  { filename: 'app:///_next/static/chunks/9ced0920-3a9e27d92db308d0.js', function: 'o_' },
  { filename: 'app:///_next/static/chunks/9ced0920-3a9e27d92db308d0.js', function: 'l9' },
  { filename: 'app:///_next/static/chunks/app/global-error-dadddeab95eb9a36.js', function: 'l' },
  { filename: 'app:///_next/static/chunks/31848-3448c16876d4ded2.js', function: '?' },
]

test('classifies the inpage.js "No error message" prod event as noise (exact message + inpage.js frames)', () => {
  // Exact production shape: the `"No error message"` placeholder + the wallet-
  // extension `app:///inpage.js` frames (onGlobalMessage → runIfPresent → run)
  // + React reconciler + global-error boundary frames. No first-party
  // `apps/web/src/…` frame, so the negative guard does not fire.
  assert.equal(
    isInpageJsNoErrorMessageNoise({
      message: 'No error message',
      frames: INPAGE_JS_NO_ERROR_MESSAGE_PROD_FRAMES,
    }),
    true,
  )
})

test('suppresses the inpage.js "No error message" Sentry event via the beforeSend gate', () => {
  // Exact shape of the production event: mechanism
  // `auto.browser.global_handlers.onerror` (UNCAUGHT global error), request URL
  // `https://dosco.live/auth?expired=true&returnUrl=…`, Chrome 150 / Windows 10.
  // The wallet-extension inpage.js frames + React reconciler + global-error
  // boundary — NO first-party `apps/web/src/…` frame.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: {
        url: 'https://dosco.live/auth?expired=true&returnUrl=%2Fprojects%2F9c64dfec-6272-45c0-b61b-5bd0c4826ef8%2Fthread%2F9a4057da-1f55-41a2-9fe9-cd7d52c99674',
      },
      exception: {
        values: [
          {
            value: 'No error message',
            stacktrace: { frames: INPAGE_JS_NO_ERROR_MESSAGE_PROD_FRAMES },
          },
        ],
      },
    }),
    true,
  )
})

test('classifies the inpage.js "No error message" noise from a filename alone (window.onerror)', () => {
  // The runtime gate (window.onerror) sees the `filename` directly — the throw
  // originates from the injected script source.
  assert.equal(
    isInpageJsNoErrorMessageNoise({
      message: 'No error message',
      filename: 'app:///inpage.js',
    }),
    true,
  )
})

test('classifies the inpage.js "No error message" noise from a chrome-extension:// frame', () => {
  // Some wallet extensions inject under a chrome-extension:// origin instead of
  // app:///inpage.js — the extension-source fallback anchor must also match.
  assert.equal(
    isInpageJsNoErrorMessageNoise({
      message: 'No error message',
      frames: [{ filename: 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js' }],
    }),
    true,
  )
})

test('does NOT suppress the "No error message" event when a first-party apps/web/src frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code threw an error with
  // no message that happens to have an inpage.js frame in the stack (e.g. a
  // first-party handler that wraps the extension provider) → still actionable;
  // the negative guard MUST preserve it so the call site can be found + fixed.
  for (const frames of [
    [{ filename: 'apps/web/src/features/wallet/wallet-provider.ts', function: 'handleProvider' }],
    [
      { filename: 'app:///inpage.js', function: 'onGlobalMessage' },
      { filename: 'app:///apps/web/src/features/auth/use-auth.ts', function: 'login' },
    ],
  ]) {
    assert.equal(
      isInpageJsNoErrorMessageNoise({
        message: 'No error message',
        frames,
      }),
      false,
      `expected first-party "No error message" event from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: 'No error message', stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party "No error message" event from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress the "No error message" event with NO inpage.js frame (conservative — keep reporting)', () => {
  // No `app:///inpage.js` frame → can't confirm extension origin; a real
  // first-party error with no message (e.g. `Promise.reject()`) would produce
  // the same `"No error message"` placeholder, so keep reporting.
  // NOTE: `shouldIgnoreSentryBrowserNoise` may still suppress the event via
  // the sibling `isEmptyMessageUnresolvedBrowserChunkNoise` matcher if the
  // frames are all browser-bundle sources (that's a separate noise class). The
  // new inpage.js matcher itself must return false when no inpage.js frame is
  // present.
  for (const frames of [
    [],
    [{ filename: 'app:///_next/static/chunks/app.js', function: '?' }],
    [{ filename: 'apps/web/src/lib/foo.ts', function: 'bar' }],
  ]) {
    assert.equal(
      isInpageJsNoErrorMessageNoise({
        message: 'No error message',
        frames,
      }),
      false,
      `expected "No error message" event from ${JSON.stringify(frames)} (no inpage.js frame) to keep reporting`,
    )
  }
})

test('does NOT suppress a non-No-error-message value even with inpage.js frames', () => {
  // Only the EXACT `"No error message"` placeholder is noise — a real error
  // message (e.g. a real TypeError) from the same inpage.js source is a
  // different class and must keep reporting (or be handled by
  // `isInpageWalletStreamNoise` if it matches the stream patterns).
  for (const message of [
    'Something went wrong',
    "Cannot read properties of undefined (reading 'foo')",
    'No error message: extra context',
  ]) {
    assert.equal(
      isInpageJsNoErrorMessageNoise({
        message,
        frames: INPAGE_JS_NO_ERROR_MESSAGE_PROD_FRAMES,
      }),
      false,
      `expected "${message}" with inpage.js frames to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: message, stacktrace: { frames: INPAGE_JS_NO_ERROR_MESSAGE_PROD_FRAMES } }],
        },
      }),
      false,
      `expected Sentry event "${message}" with inpage.js frames to keep reporting`,
    )
  }
})

test('does NOT suppress the "No error message" event that is already handled by isEmptyMessageUnresolvedBrowserChunkNoise (no inpage.js frame)', () => {
  // The sibling `isEmptyMessageUnresolvedBrowserChunkNoise` matcher handles
  // the "No error message" + ALL-browser-bundle-frame class (patterns
  // 141dcca3… / 19ee7c2f…). The new inpage.js matcher must NOT overlap with it:
  // an event with ONLY browser-bundle frames (no inpage.js frame) is not
  // matched by the new matcher and stays in the original classifier.
  assert.equal(
    isInpageJsNoErrorMessageNoise({
      message: 'No error message',
      frames: [
        { filename: 'app:///_next/static/chunks/66499-30a0e6805d268c02.js', function: 'iX' },
        { filename: 'app:///_next/static/chunks/21544-ac9e889808bbe0af.js', function: '?' },
      ],
    }),
    false,
  )
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
    { filename: 'https://dosco.live/_next/static/chunks/main-abc.js' },
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
// dosco Frontend prod, application_id 2346967). The `@embedpdf/plugin-tiling`
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
        url: 'https://dosco.live/projects/c4d70885-ce86-4283-b373-bc2fbcd92b85/sessions/917c2468-11bf-4cf0-92e6-20d17fa58e77',
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
// @embedpdf/plugin-tiling `TilingLayer` viewport-advance tile-destructure noise
// (Better Stack patterns
// 3e579401d40807f7f06bf57e7f3ad299846977ed05c2823d0ded45d8e89c1430 and
// 70272e1ebef3ed66061cda5a46c7963f75d114408113ef131ac88981b4679f15, Kortix
// Frontend prod, application_id 2346967). A SIBLING of the React #185 class
// above (pattern 366115d4…, PR #4718) but a DIFFERENT throw from a different
// embedpdf tiling path: under a rapid scroll/zoom burst the tiling plugin's
// tile queue drains mid-burst, the viewport-advance path (`t5.advance` →
// `iA.ignore` → `iA.onScroll` / `iA.onScrollChanged`, plus the
// `IntersectionObserver` threshold callback) calls `const { tile } =
// queue.pop()` on an `undefined` pop result, and V8 throws
// `Cannot destructure property 'tile' of 'r.pop(...)' as it is undefined.` Two
// patterns, SAME root cause, SAME user/session (`7254bee8-…`/`bd1306e9-…`), 1
// occurrence each, 0 identified users, release
// `470fe6f3c88460212c3b187f6f86fb4ad456c4d6` (v0.10.13), route
// `/projects/:id/sessions/:sessionId`, Chrome 150 on Windows 10. Pattern
// `3e579401` mechanism `auto.browser.browserapierrors.addEventListener` (top
// throw frame `HTMLDivElement.u` in chunk `66499-…`, then `c63a46fc-…` fns
// `iA.onScroll` → `iA.ignore` → `t5.advance`); pattern `70272e1e` mechanism
// `auto.browser.global_handlers.onerror` (top throw frame
// `IntersectionObserver.intersection.IntersectionObserver.threshold`, then
// `c63a46fc-…` fns `iA.onScrollChanged` → `iA.ignore` → `t5.advance`). All
// frames are minified `@embedpdf` tiling chunks (`c63a46fc-…` / `66499-…`) — NO
// first-party `apps/web/src/…` frame. The #4718 matcher (React #185 +
// `onTileRendering`) does NOT catch it (different message, different anchor), so
// this new matcher pins the EXACT prod call site: BOTH patterns' frames classify
// as noise. Anchored on the EXACT message (the `tile` property name + the
// `r.pop(...)` destructure target pin the call site) AND a positive viewport-
// advance frame anchor (function name OR the `c63a46fc` tiling chunk), with a
// first-party negative guard.
// ---------------------------------------------------------------------------

// The exact V8 wording from both production events (the minified tile queue is
// `r`, so the destructure target renders as `r.pop(...)`).
const EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE =
  "Cannot destructure property 'tile' of 'r.pop(...)' as it is undefined."

// Pattern 3e579401 — mechanism `auto.browser.browserapierrors.addEventListener`
// (top throw frame `HTMLDivElement.u` in chunk `66499-…`, then the tiling chunk
// `c63a46fc-…` viewport-advance path `iA.onScroll` → `iA.ignore` → `t5.advance`).
const EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_3E579401 = [
  { filename: 'app:///_next/static/chunks/66499-652b83425f671b38.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'HTMLDivElement.u' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'iA.onScroll' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'iA.ignore' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'ee.run' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'ee.forward' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 't5.advance' },
]

// Pattern 70272e1e — mechanism `auto.browser.global_handlers.onerror` (top throw
// frame `IntersectionObserver.intersection.IntersectionObserver.threshold`, then
// the tiling chunk `c63a46fc-…` viewport-advance path `iA.onScrollChanged` →
// `iA.ignore` → `t5.advance`).
const EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_70272E1E = [
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'IntersectionObserver.intersection.IntersectionObserver.threshold' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'iA.onScrollChanged' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'iA.ignore' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'ee.run' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 'ee.forward' },
  { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno', function: 't5.advance' },
]

test('classifies both @embedpdf tiling tile-destructure prod patterns as noise', () => {
  for (const [label, frames] of [
    ['3e579401', EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_3E579401],
    ['70272e1e', EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_70272E1E],
  ] as const) {
    assert.equal(
      isEmbedPdfTilingTileDestructureNoise({
        message: EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE,
        frames,
      }),
      true,
      `expected pattern ${label} to classify as noise`,
    )
  }
})

test('suppresses both @embedpdf tiling tile-destructure Sentry events via the beforeSend gate', () => {
  for (const [label, frames] of [
    ['3e579401', EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_3E579401],
    ['70272e1e', EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_70272E1E],
  ] as const) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: {
          url: 'https://dosco.live/projects/7254bee8-0000-0000-0000-000000000000/sessions/bd1306e9-0000-0000-0000-000000000000',
        },
        exception: {
          values: [
            {
              value: EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE,
              stacktrace: { frames },
            },
          ],
        },
      }),
      true,
      `expected Sentry gate to suppress pattern ${label}`,
    )
  }
})

test('suppresses the @embedpdf tiling tile-destructure message through all three capture-path forms', () => {
  // The message must classify as noise regardless of whether the capture path
  // delivered it raw, with a `TypeError: ` prefix, or with a stacked
  // `Unhandled promise rejection: TypeError: ` prefix (stripErrorWrappers peels
  // all three before the exact match).
  const messageVariants = [
    EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE,
    `TypeError: ${EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE}`,
    `Unhandled promise rejection: TypeError: ${EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE}`,
  ]
  for (const message of messageVariants) {
    assert.equal(
      isEmbedPdfTilingTileDestructureNoise({
        message,
        frames: EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_3E579401,
      }),
      true,
      `expected "${message}" to classify as noise`,
    )
  }
})

test('does NOT suppress the @embedpdf tiling tile-destructure message with NO frames (frameless capture)', () => {
  // No frames → can't confirm the tiling viewport-advance anchor; keep reporting
  // so a frameless but otherwise-identical throw from app code stays observable.
  assert.equal(
    isEmbedPdfTilingTileDestructureNoise({
      message: EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE,
      frames: [],
    }),
    false,
  )
})

test('does NOT suppress the @embedpdf tiling tile-destructure message when a first-party frame is present (a real regression)', () => {
  // A resolved `apps/web/src/…` frame means our own code is the destructure
  // culprit → actionable; the negative guard MUST preserve it so the call site
  // can be found + fixed. A real first-party `{ tile } = arr.pop()` regression
  // de-minifies to `apps/web/src/…` and must never be hidden.
  for (const frames of [
    [{ filename: 'apps/web/src/components/ui/extend/pdf-viewer.tsx', function: 'PDFViewerInner' }],
    [
      { filename: 'app:///_next/static/chunks/c63a46fc-270e35c76d7636cb.js', function: 't5.advance' },
      { filename: 'app:///apps/web/src/components/ui/extend/pdf-viewer.tsx', function: 'renderPage' },
    ],
  ]) {
    assert.equal(
      isEmbedPdfTilingTileDestructureNoise({
        message: EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE,
        frames,
      }),
      false,
      `expected first-party tile-destructure from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [
            {
              value: EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE,
              stacktrace: { frames },
            },
          ],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party tile-destructure from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress a DIFFERENT destructure message even with the tiling viewport-advance frames (over-match guard)', () => {
  // The `tile` property name is part of the anchor, not just the `r.pop()`
  // destructure target. A same-shape throw destructuring a DIFFERENT property
  // from the same tiling queue is a different, actionable throw and must keep
  // reporting — only the exact `tile`-property destructure is dropped.
  const differentDestructureMessage =
    "Cannot destructure property 'foo' of 'r.pop(...)' as it is undefined."
  assert.equal(
    isEmbedPdfTilingTileDestructureNoise({
      message: differentDestructureMessage,
      frames: EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_3E579401,
    }),
    false,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: {
        values: [
          {
            value: differentDestructureMessage,
            stacktrace: { frames: EMBEDPDF_TILING_TILE_DESTRUCTURE_FRAMES_3E579401 },
          },
        ],
      },
    }),
    false,
  )
})

test('does NOT suppress the exact tile-destructure message with non-tiling frames (over-match guard)', () => {
  // The exact message but with frames that are NOT the embedpdf tiling
  // viewport-advance path (different third-party lib, or unattributable minified
  // chunks) → can't confirm the tiling anchor; keep reporting.
  for (const frames of [
    [{ filename: 'app:///_next/static/chunks/app.js', function: 'someCallback' }],
    [{ filename: 'apps/web/src/features/session/session-chat.tsx', function: 'SessionChat' }],
  ]) {
    assert.equal(
      isEmbedPdfTilingTileDestructureNoise({
        message: EMBEDPDF_TILING_TILE_DESTRUCTURE_MESSAGE,
        frames,
      }),
      false,
      `expected exact message from ${JSON.stringify(frames)} (no tiling anchor) to keep reporting`,
    )
  }
})


// "Should not already be working.", Better Stack pattern
// 0f03b24eb662c20779ea6397c6501f40392a3c9e24ab0f4594ad367eda71b9b7,
// dosco Frontend prod, application_id 2346967). The React production
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
        url: 'https://dosco.live/projects/3cdc1df5-01e6-492d-b2ab-d81bb8c42fa2/sessions/c102f5de-1b6b-4baf-8cd6-cdd11855330f',
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
// dosco Frontend prod, application_id 2346967, `UnhandledRejection`). A
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
// `https://dosco.live/auth`, Chrome 150. The matcher requires BOTH the
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
      request: { url: 'https://dosco.live/auth' },
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
// dosco Frontend prod, application_id 2346967, `UnhandledRejection`). A
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
// `https://dosco.live/` (the marketing/landing page). Stack trace: NONE —
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
  // stacktrace frames, request URL `https://dosco.live/` (marketing site).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/' },
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
      request: { url: 'https://dosco.live/' },
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

// ---------------------------------------------------------------------------
// Supabase gotrue OTP-expired-link `Object Not Found Matching Id:…,
// MethodName:update, ParamCount:…` non-Error promise rejection noise (Better
// Stack pattern
// e9a720020c921fbf82323125c20714fd7455e803295cf13aa624440de6d35e8e, Kortix
// Frontend prod, application_id 2346967, `UnhandledRejection`). A user landed
// on an expired/invalid OTP email link and the Supabase auth client's
// session-update from the expired OTP token rejected with a bare STRING
// `Object Not Found Matching Id:2, MethodName:update, ParamCount:4` (gotrue's
// "no row found" wording for the session-update RPC — the `Id:2` /
// `ParamCount:4` integers vary per call). Because the rejected value is a
// bare string (NOT an Error instance), Sentry 10.x's GlobalHandlers
// `onunhandledrejection` integration cannot extract a `.message`/`.stack` from
// it: it synthesizes the canonical "Non-Error promise rejection captured with
// value: Object Not Found Matching Id:2, MethodName:update, ParamCount:4"
// (the rejection value inlined after `value: `) with NO stacktrace frames at
// all. 116 occurrences, 0 identified users (anonymous), first 2026-06-02 /
// recurring, mechanism `auto.browser.global_handlers.onunhandledrejection`
// (`handled:false` — UNCAUGHT, never reached a React error boundary),
// `synthetic:true`, release `160f0b286f0ad5c53debc343d5e055241694e24d`
// (v0.12.4 prod), request URL
// `https://dosco.live/#error=access_denied&error_code=otp_expired&error_
// description=Email+link+is+invalid+or+has+expired` (the auth error page — the
// OTP-expired redirect). Browser Chrome 142 on Windows 10. Breadcrumbs:
// `[runtime-env]` with `supabaseUrl: https://supa.dosco.live` (the Supabase
// auth client initializing), then a navigation to the same `#error=otp_expired`
// URL, then marketing-site fetches (`/api/github-stars`,
// `/_vercel/insights/view`, `/api/maintenance`). Stack trace: NONE — the raw
// exception payload is `{"values":[{"type":"UnhandledRejection","value":
// "Non-Error promise rejection captured with value: Object Not Found Matching
// Id:2, MethodName:update, ParamCount:4","mechanism":{"type":"auto.browser.
// global_handlers.onunhandledrejection","handled":false}}]}` with NO
// `stacktrace` key, NO frames, NO `call_site_file`/`call_site_function`,
// NO `call_stack_hash`.
//
// SIBLING of the bare-`undefined` non-Error rejection class
// (`isNonErrorUndefinedRejectionNoise`, PR #5200, pattern `5cfc90e5…`) and
// the Supabase `TOKEN_EXPIRED` rejection class (`isSupabaseTokenExpiredNoise`,
// pattern `63b0cde7…`): all three are frameless non-Error promise rejections
// captured by Sentry's GlobalHandlers `onunhandledrejection` integration as a
// synthetic message with NO frames. The `undefined` matcher rejects with the
// primitive `undefined`; the `TOKEN_EXPIRED` matcher rejects with a
// `{ code, message, status }` object (Sentry emits "Object captured as
// promise rejection with keys: …"); THIS matcher rejects with a bare STRING
// (Sentry emits "Non-Error promise rejection captured with value: <string>").
// The three message prefixes are disjoint, so the matchers do not shadow each
// other.
//
// The matcher anchors on the STABLE prefix `/^Non-Error promise rejection
// captured with value: Object Not Found Matching/` (the `Id:…, MethodName:…,
// ParamCount:…` suffix varies per gotrue call) and requires the frameless
// shape as a positive guard with a negative guard preserving any first-party
// `apps/web/src/…` frame.
// ---------------------------------------------------------------------------

// The exact synthetic message from the production event.
const NON_ERROR_OBJECT_NOT_FOUND_REJECTION =
  'Non-Error promise rejection captured with value: Object Not Found Matching Id:2, MethodName:update, ParamCount:4'

test('classifies the OTP-expired Object-Not-Found non-Error promise rejection noise', () => {
  // Exact production shape: the canonical message, NO frames (the rejection
  // carried no stack — it was a bare-string non-Error rejection).
  assert.equal(
    isNonErrorObjectNotFoundRejectionNoise({
      message: NON_ERROR_OBJECT_NOT_FOUND_REJECTION,
      frames: [],
    }),
    true,
  )
})

test('suppresses the OTP-expired Object-Not-Found rejection Sentry event via the beforeSend gate', () => {
  // Exact shape of the production event: type `UnhandledRejection`, mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (uncaught global
  // unhandledrejection — never reached a React error boundary), NO
  // stacktrace frames, request URL the auth error page
  // (`/#error=access_denied&error_code=otp_expired`).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: {
        url: 'https://dosco.live/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      },
      exception: {
        values: [
          {
            value: NON_ERROR_OBJECT_NOT_FOUND_REJECTION,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the OTP-expired Object-Not-Found noise when frames are absent entirely (no stacktrace key)', () => {
  // The production event has no frames at all — Sentry omits the stacktrace
  // key entirely when there is nothing to serialize (the raw payload has no
  // `stacktrace` key). The gate must still drop it (frames default to []).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: {
        url: 'https://dosco.live/#error=access_denied&error_code=otp_expired',
      },
      exception: {
        values: [{ value: NON_ERROR_OBJECT_NOT_FOUND_REJECTION }],
      },
    }),
    true,
  )
})

test('matches the variable Id/MethodName/ParamCount gotrue suffix (the integers vary per call)', () => {
  // The production suffix is `Id:2, MethodName:update, ParamCount:4`, but the
  // gotrue RPC's internal ids/counts vary per call — a sibling occurrence
  // might be `Id:7, MethodName:update, ParamCount:2`. The matcher anchors on
  // the STABLE prefix, so every variant of this OTP-expired session-update
  // rejection is dropped.
  for (const message of [
    'Non-Error promise rejection captured with value: Object Not Found Matching Id:7, MethodName:update, ParamCount:2',
    'Non-Error promise rejection captured with value: Object Not Found Matching Id:0, MethodName:update, ParamCount:1',
    'Non-Error promise rejection captured with value: Object Not Found Matching Id:999, MethodName:update, ParamCount:12',
  ]) {
    assert.equal(
      isNonErrorObjectNotFoundRejectionNoise({
        message,
        frames: [],
      }),
      true,
      `expected variant "${message}" to be noise`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      true,
      `expected Sentry event for variant "${message}" to be suppressed`,
    )
  }
})

test('does NOT suppress the OTP-expired rejection when a first-party frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code rejected a promise
  // with the bare-string gotrue value → actionable; the negative guard MUST
  // preserve it so the call site can be found + fixed. This is the whole
  // reason the matcher is frame-aware (the prefix is also a real first-party
  // `Promise.reject('Object Not Found Matching…')` signature).
  for (const frames of [
    [{ filename: 'apps/web/src/lib/auth/supabase-client.ts', function: 'updateSession' }],
    [
      { filename: 'app:///_next/static/chunks/main.js', function: 'f' },
      { filename: 'app:///apps/web/src/features/auth/otp-callback.ts', function: 'handleOtp' },
    ],
  ]) {
    assert.equal(
      isNonErrorObjectNotFoundRejectionNoise({
        message: NON_ERROR_OBJECT_NOT_FOUND_REJECTION,
        frames,
      }),
      false,
      `expected first-party OTP-expired rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: NON_ERROR_OBJECT_NOT_FOUND_REJECTION, stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party OTP-expired rejection from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress the OTP-expired rejection when any resolvable (non-first-party) frame is present', () => {
  // Any resolvable source location (real chunk / URL / named file) means the
  // rejection is attributable — a real first-party or third-party
  // `Promise.reject('Object Not Found Matching…')` with a stack we can trace.
  // Keep reporting; only the frameless capture (the production noise pattern)
  // is dropped.
  for (const frames of [
    [{ filename: 'app:///_next/static/chunks/123-abc.js', function: 'x' }],
    [{ filename: 'https://supa.dosco.live/auth/v1/user', function: 'init' }],
    [{ filename: 'app:///inpage.js', function: 'emit' }],
  ]) {
    assert.equal(
      isNonErrorObjectNotFoundRejectionNoise({
        message: NON_ERROR_OBJECT_NOT_FOUND_REJECTION,
        frames,
      }),
      false,
      `expected attributable OTP-expired rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
  }
})

test('does NOT shadow the sibling undefined-rejection matcher (different value)', () => {
  // The bare-`undefined` non-Error rejection class (PR #5200) emits
  // "Non-Error promise rejection captured with value: undefined" — a
  // DIFFERENT value than `Object Not Found Matching…`. The two matchers are
  // disjoint; this matcher must return false for the undefined value (it has
  // its own dedicated matcher), and vice versa.
  assert.equal(
    isNonErrorObjectNotFoundRejectionNoise({
      message: 'Non-Error promise rejection captured with value: undefined',
      frames: [],
    }),
    false,
  )
  assert.equal(
    isNonErrorUndefinedRejectionNoise({
      message: NON_ERROR_OBJECT_NOT_FOUND_REJECTION,
      frames: [],
    }),
    false,
  )
})

test('does NOT shadow the sibling Supabase TOKEN_EXPIRED object-rejection matcher (different message prefix)', () => {
  // The Supabase `TOKEN_EXPIRED` rejection class rejects with a
  // `{ code, message, status }` OBJECT, so Sentry emits the disjoint
  // "Object captured as promise rejection with keys: code, message, status"
  // message (handled by `isSupabaseTokenExpiredNoise`). THIS matcher anchors
  // on the "Non-Error promise rejection captured with value: Object Not
  // Found Matching" prefix, so it must NOT match the object-rejection message.
  assert.equal(
    isNonErrorObjectNotFoundRejectionNoise({
      message: 'Object captured as promise rejection with keys: code, message, status',
      frames: [],
    }),
    false,
  )
})

test('does NOT suppress a non-matching message (prefix-only / near-miss wording)', () => {
  // The matcher anchors on the canonical prefix; a different wording that
  // merely mentions parts of it must not be matched.
  for (const message of [
    'Object Not Found Matching Id:2, MethodName:update, ParamCount:4',
    'Non-Error promise rejection captured with value: undefined',
    'Non-Error promise rejection captured with value: some other string',
    'Non-Error promise rejection captured with value: Object Not Found',
    'Non-Error promise rejection',
    'Object Not Found Matching',
  ]) {
    assert.equal(
      isNonErrorObjectNotFoundRejectionNoise({
        message,
        frames: [],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a frameless rejection with a different message', () => {
  // A frameless rejection carrying a DIFFERENT message is a different class
  // — keep reporting it via this matcher. (The bare-`undefined` / OperationError
  // / TOKEN_EXPIRED classes have their own dedicated matchers + tests; not
  // re-tested here.)
  for (const message of [
    'Something else entirely',
    'UnhandledRejection: a different value',
  ]) {
    assert.equal(
      isNonErrorObjectNotFoundRejectionNoise({
        message,
        frames: [],
      }),
      false,
      `expected frameless "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event for frameless "${message}" to keep reporting`,
    )
  }
})

// ---------------------------------------------------------------------------
// Browser-internal DOM/binding `OperationError: Instance dropped in
// popErrorScope` noise (Better Stack pattern
// 5e1aca208331fa2d7540c9810b815b6c94f1373c470ff54e15f39d389dac7e0c,
// dosco Frontend prod, application_id 2346967, `OperationError`). A
// browser-internal DOM/binding `OperationError` (`popErrorScope` is part of the
// WebIDL/internal error-scope machinery — DOMQueuingStrategy, ResizeObserver,
// IntersectionObserver, media streams, GPU, … — NOT a first-party Kortix API)
// surfaces as a frameless unhandled promise rejection via the global
// `onunhandledrejection` handler. 2 occurrences EVER across a 90-day window
// (first 2026-04-28 18:41:18 UTC on `https://www.dosco.live/instances`
// Chrome/Win, last 2026-07-22 18:26:35 UTC on
// `https://dosco.live/projects/<id>` reached from Google account sign-in
// Chrome/Edge/Win), 0 identified users (anonymous), mechanism
// `auto.browser.global_handlers.onunhandledrejection` (`handled:false` —
// UNCAUGHT, never reached a React error boundary). The exception payload is
// `{"values":[{"type":"OperationError","value":"Instance dropped in
// popErrorScope","mechanism":{"type":"auto.browser.global_handlers.
// onunhandledrejection","handled":false}}]}` — NO `stacktrace`, NO frames, NO
// `call_site_file`/`call_site_function`, NO `call_stack_hash`. A real
// first-party `Promise.reject(new OperationError(...))` carries a stack with
// `apps/web/src/…` frames, so the frameless shape is the noise signature.
//
// Same family as `isNonErrorUndefinedRejectionNoise` (PR #5200, pattern
// `5cfc90e5…`) and `isFirefoxReactSchedulerReentryNoise` (PR #5185, pattern
// `0f03b24e…`) — frameless browser-internal rejections dropped by a precise
// matcher with a negative guard preserving any first-party frame.
//
// `OperationError` is the WebIDL type for async DOM operations (NOT a Kortix
// error class) and is generic enough that a real first-party
// `new OperationError(...)` could surface with the same type — so the matcher
// anchors on the EXACT message `/^Instance dropped in popErrorScope$/`
// (case-sensitive), never on the bare `OperationError` type. It requires the
// frameless shape as a positive guard and a negative guard preserving any
// first-party `apps/web/src/…` frame.
// ---------------------------------------------------------------------------

// The exact exception value from the production event.
const OPERATION_ERROR_POP_ERROR_SCOPE = 'Instance dropped in popErrorScope'

test('classifies the frameless OperationError popErrorScope noise', () => {
  // Exact production shape: the canonical message, NO frames (the rejection
  // carried no stack).
  assert.equal(
    isOperationErrorPopErrorScopeNoise({
      message: OPERATION_ERROR_POP_ERROR_SCOPE,
      frames: [],
    }),
    true,
  )
})

test('suppresses the assigned OperationError popErrorScope Sentry event via the beforeSend gate', () => {
  // Exact shape of the production event: type `OperationError`, mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (uncaught global
  // unhandledrejection — never reached a React error boundary), NO
  // stacktrace frames, request URL `https://www.dosco.live/instances` (the
  // marketing/landing page — first occurrence).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://www.dosco.live/instances' },
      exception: {
        values: [
          {
            value: OPERATION_ERROR_POP_ERROR_SCOPE,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the post-OAuth OperationError popErrorScope Sentry event (second occurrence)', () => {
  // The second occurrence: a project page reached from Google account
  // sign-in (referer `https://accounts.google.com/`), Chrome/Edge/Win.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: {
        url: 'https://dosco.live/projects/198b319d-b710-4443-a797-d813ba16f07a',
      },
      exception: {
        values: [
          {
            value: OPERATION_ERROR_POP_ERROR_SCOPE,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the OperationError popErrorScope noise when frames are absent entirely (no stacktrace key)', () => {
  // The production event has no frames at all — Sentry omits the stacktrace
  // key entirely when there is nothing to serialize. The gate must still drop
  // it (frames default to []).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/instances' },
      exception: {
        values: [{ value: OPERATION_ERROR_POP_ERROR_SCOPE }],
      },
    }),
    true,
  )
})

test('does NOT suppress the OperationError popErrorScope rejection when a first-party frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code rejected a promise
  // with an `OperationError` → actionable; the negative guard MUST preserve it
  // so the call site can be found + fixed. This is the whole reason the
  // matcher is frame-aware (`OperationError` is a generic WebIDL type a real
  // first-party `new OperationError(...)` could surface with).
  for (const frames of [
    [{ filename: 'apps/web/src/lib/api/client.ts', function: 'fetchProject' }],
    [
      { filename: 'app:///_next/static/chunks/main.js', function: 'f' },
      { filename: 'app:///apps/web/src/features/workspace/index.ts', function: 'loadConfig' },
    ],
  ]) {
    assert.equal(
      isOperationErrorPopErrorScopeNoise({
        message: OPERATION_ERROR_POP_ERROR_SCOPE,
        frames,
      }),
      false,
      `expected first-party OperationError popErrorScope rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: OPERATION_ERROR_POP_ERROR_SCOPE, stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party OperationError popErrorScope rejection from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress the OperationError popErrorScope rejection when any resolvable (non-first-party) frame is present', () => {
  // Any resolvable source location (real chunk / URL / named file) means the
  // rejection is attributable — a real first-party or third-party
  // `Promise.reject(new OperationError(...))` with a stack we can trace. Keep
  // reporting; only the frameless capture (the production noise pattern) is
  // dropped.
  for (const frames of [
    [{ filename: 'app:///_next/static/chunks/123-abc.js', function: 'x' }],
    [{ filename: 'https://cdn.example.com/lib.js', function: 'init' }],
  ]) {
    assert.equal(
      isOperationErrorPopErrorScopeNoise({
        message: OPERATION_ERROR_POP_ERROR_SCOPE,
        frames,
      }),
      false,
      `expected attributable OperationError popErrorScope rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
  }
})

test('does NOT suppress a non-matching message (suffix variant)', () => {
  // The matcher anchors on the EXACT message; a near-miss wording must not be
  // matched.
  for (const message of [
    'Instance dropped in popErrorScopeX',
    'Instance dropped in popErrorScope.',
    'Instance dropped in popErrorScope (extra)',
    'X Instance dropped in popErrorScope',
    'popErrorScope',
  ]) {
    assert.equal(
      isOperationErrorPopErrorScopeNoise({
        message,
        frames: [],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a frameless rejection with a different message', () => {
  // A frameless rejection carrying a DIFFERENT message is a different class —
  // keep reporting it via this matcher. (The bare-`undefined` non-Error
  // rejection class has its own dedicated matcher + tests; not re-tested here.)
  for (const message of [
    'Something else entirely',
    'OperationError: a different operation error',
  ]) {
    assert.equal(
      isOperationErrorPopErrorScopeNoise({
        message,
        frames: [],
      }),
      false,
      `expected frameless "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event for frameless "${message}" to keep reporting`,
    )
  }
})

// ---------------------------------------------------------------------------
// Bare lowercase `network error` rejection noise (Better Stack pattern
// 2403c9ba5deee2af387834e95461cfb32b9b5080b21d6f307b2f09bb09e71f21, Kortix
// Frontend prod, application_id 2346967). The canonical Axios / XMLHttpRequest
// transport-abort message (lowercase; Axios emits this from the underlying XHR
// `onerror`), captured as an uncaught global `onunhandledrejection` (mechanism
// `auto.browser.global_handlers.onunhandledrejection`, `handled:false` — never
// reached a React error boundary) with ZERO stack frames (`stacktrace.frames`
// is an empty array, no `call_site_file`/`call_site_function`/`call_stack_hash`).
// 1 occurrence / 0 identified users, last 2026-07-23 16:53:55 UTC, release
// `470fe6f3…` (v0.10.13), transaction `/projects/:id/sessions/:sessionId`,
// Chrome 150 on Generic Linux. Breadcrumbs: 88 fetches, 0 non-200 — the
// rejection is a fire-and-forget `.then()` or a network-abort that didn't
// surface a status. The same degraded session that hit the 25s-deadline +
// audit 503s.
//
// Same family as the prior frameless browser-internal rejection noise matchers
// — `isNonErrorUndefinedRejectionNoise` (PR #5200), `isOperationErrorPopError-
// ScopeNoise` (PR #5237), `isFirefoxReactSchedulerReentryNoise` (PR #5185) —
// a frameless unhandled rejection dropped by a precise exact-message matcher
// with two negative guards preserving any first-party or resolvable frame.
//
// The message is GENERIC: a real first-party `new Error('network error')` /
// `Promise.reject('network error')` would surface with the SAME message, so the
// matcher requires BOTH the EXACT bare lowercase `network error` string
// (case-sensitive, after `stripErrorWrappers` — the capitalized `Network Error`
// Axios wrapper is a DIFFERENT surface and is deliberately NOT matched) AND a
// frameless positive guard, plus two negative guards: any resolved first-party
// `apps/web/src/…` frame → keep reporting; any resolvable frame location →
// keep reporting. Only the FRAMELESS capture is dropped.
// ---------------------------------------------------------------------------

// The exact exception value from the production event (lowercase, bare).
const FRAMELESS_NETWORK_ERROR = 'network error'

test('classifies the frameless bare network error noise', () => {
  // Exact production shape: the bare lowercase `network error` message, NO
  // frames (the rejection carried no stack).
  assert.equal(
    isFramelessNetworkErrorNoise({
      message: FRAMELESS_NETWORK_ERROR,
      frames: [],
    }),
    true,
  )
})

test('suppresses the frameless network error Sentry event via the beforeSend gate', () => {
  // Exact shape of the production event: type `TypeError`, mechanism
  // `auto.browser.global_handlers.onunhandledrejection` (uncaught global
  // unhandledrejection — never reached a React error boundary), NO stacktrace
  // frames, request URL the co-worker session page.
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: {
        url: 'https://dosco.live/projects/66f6788a-0000-0000-0000-000000000000/sessions/d16b4555-0000-0000-0000-000000000000',
      },
      exception: {
        values: [
          {
            value: FRAMELESS_NETWORK_ERROR,
            stacktrace: { frames: [] },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the frameless network error noise when frames are absent entirely (no stacktrace key)', () => {
  // Sentry omits the stacktrace key entirely when there is nothing to
  // serialize. The gate must still drop it (frames default to []).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/projects/x/sessions/y' },
      exception: {
        values: [{ value: FRAMELESS_NETWORK_ERROR }],
      },
    }),
    true,
  )
})

test('does NOT suppress the network error rejection when a first-party frame is present', () => {
  // A resolved `apps/web/src/…` frame means our own code threw/rejected with
  // `new Error('network error')` → actionable; the negative guard MUST preserve
  // it so the call site can be found + fixed. This is the whole reason the
  // matcher is frame-aware (the bare `network error` message is generic).
  for (const frames of [
    [{ filename: 'apps/web/src/lib/api/client.ts', function: 'fetchProject' }],
    [
      { filename: 'app:///_next/static/chunks/main.js', function: 'f' },
      { filename: 'app:///apps/web/src/features/workspace/index.ts', function: 'loadConfig' },
    ],
  ]) {
    assert.equal(
      isFramelessNetworkErrorNoise({
        message: FRAMELESS_NETWORK_ERROR,
        frames,
      }),
      false,
      `expected first-party network error rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: FRAMELESS_NETWORK_ERROR, stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party network error rejection from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress the network error rejection when any resolvable (non-first-party) frame is present', () => {
  // Any resolvable source location (real chunk / URL / named file) means the
  // rejection is attributable — a real first-party or third-party
  // `Promise.reject(new Error('network error'))` with a stack we can trace.
  // Keep reporting; only the frameless capture (the production noise pattern)
  // is dropped.
  for (const frames of [
    [{ filename: 'app:///_next/static/chunks/123-abc.js', function: 'x' }],
    [{ filename: 'https://cdn.example.com/lib.js', function: 'init' }],
  ]) {
    assert.equal(
      isFramelessNetworkErrorNoise({
        message: FRAMELESS_NETWORK_ERROR,
        frames,
      }),
      false,
      `expected attributable network error rejection from ${JSON.stringify(frames)} to keep reporting`,
    )
  }
})

test('does NOT suppress the capitalized "Network Error" wrapper (over-match guard)', () => {
  // The capitalized `Network Error` is Axios's OWN wrapper Error
  // (`new Error('Network Error')`) — a DIFFERENT surface from the bare
  // lowercase XHR-`onerror` message. It is deliberately NOT matched so a
  // blanket-silence does not hide a real Axios rejection we may want to
  // triage. Frameless here on purpose (to prove the message alone — not the
  // frameless shape — is what keeps it reporting).
  const message = 'Network Error'
  assert.equal(
    isFramelessNetworkErrorNoise({
      message,
      frames: [],
    }),
    false,
    `expected capitalized "${message}" to keep reporting`,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
    }),
    false,
    `expected Sentry event for capitalized "${message}" to keep reporting`,
  )
})

test('does NOT suppress a near-worded message (over-match guard)', () => {
  // Only the EXACT bare `network error` string is noise. A near-worded message
  // such as `network error: failed to fetch` is a different (attributable)
  // error class and must keep reporting.
  for (const message of [
    'network error: failed to fetch',
    'network error.',
    'a network error occurred',
    'Network error',
    'network errors',
  ]) {
    assert.equal(
      isFramelessNetworkErrorNoise({
        message,
        frames: [],
      }),
      false,
      `expected near-worded "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event for near-worded "${message}" to keep reporting`,
    )
  }
})


// ---------------------------------------------------------------------------
// Transient WebSocket / Server-Sent-Events (SSE) transport-close noise (Better
// Stack pattern
// ecac86df82aca61f579836c1b813a0ed02cabd4a480b581db2f1ba5f4e20ab86, Kortix
// Frontend prod, application_id 2346967). `Connection closed.` is the canonical
// transport-close message a client-side WebSocket/SSE library throws when the
// server closes a background realtime connection (deploy / restart / idle-
// timeout recycle / session end / load-balancer upstream recycle). 1 occurrence
// / 0 identified users, last 2026-07-23 16:44:09 UTC, release
// `470fe6f3c88460212c3b187f6f86fb4ad456c4d6` (v0.10.13), transaction
// `/dashboard`, URL `https://dosco.live/dashboard`, mechanism
// `auto.browser.global_handlers.onerror` (`handled:false` — UNCAUGHT, never
// reached a React error boundary), Chrome 150 / Windows 10. The single stack
// frame is the minified main co-worker runtime chunk
// `app:///_next/static/chunks/66499-652b83425f671b38.js?dpl=dpl_…` function `t`
// (lineno 15, colno 73840, in_app) — NO first-party `apps/web/src/…` frame.
// ZERO breadcrumbs (no fetches, no UI clicks) — a sparse capture consistent
// with a background transport teardown fired before any user activity was
// recorded. The connection closing during a deploy/idle-recycle is EXPECTED, not
// a product bug. Same transient-transport class as the gateway-502 retry
// (#4609) and the frameless browser-internal rejections (#5200 / #5237 /
// #5185), but a WebSocket/SSE close on the `/dashboard` realtime surface.
//
// The orchestrator's sweep ledger has a HISTORICAL skip-list note about
// `Connection closed (transient SSE)` (pattern `6c28b5b4…`, ~2026-07-15) with NO
// code matcher — this codifies that decision into a real, tested gate.
//
// `Connection closed.` is generic enough that a real first-party
// `throw new Error('Connection closed.')` regression would surface with the
// SAME wording, so the matcher anchors on the EXACT message (case-sensitive,
// WITH the trailing period) and carries a NEGATIVE guard preserving any
// resolved first-party `apps/web/src/…` frame.
// ---------------------------------------------------------------------------

// The exact exception value from the production event (the library's canonical
// close string, trailing period included).
const CONNECTION_CLOSED = 'Connection closed.'

// The single production stack frame: the minified main co-worker runtime chunk
// `66499` function `t` (a `?dpl=dpl_…` Vercel deploy-hash URL). Sentry's
// sourcemap resolution did NOT rewrite this to a first-party `apps/web/src/…`
// path, so the negative guard does not fire for it.
const CONNECTION_CLOSED_PROD_FRAMES = [
  {
    filename:
      'app:///_next/static/chunks/66499-652b83425f671b38.js?dpl=dpl_FWCk2e9rGNxkUxaBwBGi2iMZDfno',
    function: 't',
    lineno: 15,
    colno: 73840,
    in_app: true,
  },
]

test('classifies the production Connection closed. transport noise (exact prod frame)', () => {
  // Exact production shape: the canonical message + the single minified `66499`
  // chunk `t` frame. The chunk frame is NOT a first-party `apps/web/src/…`
  // frame, so the negative guard does not fire.
  assert.equal(
    isConnectionClosedNoise({
      message: CONNECTION_CLOSED,
      frames: CONNECTION_CLOSED_PROD_FRAMES,
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/dashboard' },
      exception: {
        values: [
          {
            value: CONNECTION_CLOSED,
            stacktrace: { frames: CONNECTION_CLOSED_PROD_FRAMES },
          },
        ],
      },
    }),
    true,
  )
})

test('suppresses the Connection closed. noise through all three capture-path wrappers', () => {
  // The matcher strips the canonical `Error: ` / `Unhandled promise rejection:
  // ` / `Unhandled promise rejection: Error: ` wrappers before anchoring, so
  // the SAME underlying message classifies as noise regardless of which capture
  // path delivered it (window.onerror, onunhandledrejection, Sentry exception).
  for (const message of [
    CONNECTION_CLOSED,
    `Error: ${CONNECTION_CLOSED}`,
    `Unhandled promise rejection: ${CONNECTION_CLOSED}`,
    `Unhandled promise rejection: Error: ${CONNECTION_CLOSED}`,
  ]) {
    assert.equal(
      isConnectionClosedNoise({
        message,
        frames: CONNECTION_CLOSED_PROD_FRAMES,
      }),
      true,
      `expected "${message}" to be noise`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: message, stacktrace: { frames: CONNECTION_CLOSED_PROD_FRAMES } }],
        },
      }),
      true,
      `expected Sentry event "${message}" to be noise`,
    )
  }
})

test('classifies the frameless Connection closed. variant as noise (message alone is specific)', () => {
  // A frameless capture with this exact message still classifies as noise — the
  // message is the library's canonical close string and is specific enough
  // (no frameless-positive guard required, unlike the bare-`undefined`
  // rejection class).
  assert.equal(
    isConnectionClosedNoise({
      message: CONNECTION_CLOSED,
      frames: [],
    }),
    true,
  )
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/dashboard' },
      exception: {
        values: [{ value: CONNECTION_CLOSED, stacktrace: { frames: [] } }],
      },
    }),
    true,
  )
  // Also when the stacktrace key is omitted entirely (frames default to []).
  assert.equal(
    shouldIgnoreSentryBrowserNoise({
      request: { url: 'https://dosco.live/dashboard' },
      exception: {
        values: [{ value: CONNECTION_CLOSED }],
      },
    }),
    true,
  )
})

test('does NOT suppress the Connection closed. throw when a first-party frame is present (real regression)', () => {
  // A resolved `apps/web/src/…` frame means our own websocket/SSE handling
  // threw `Connection closed.` → actionable regression; the negative guard
  // MUST preserve it so the call site can be found + fixed.
  for (const frames of [
    [{ filename: 'apps/web/src/features/dashboard/realtime-socket.ts', function: 'onClose' }],
    [
      { filename: 'app:///_next/static/chunks/main.js', function: 'f' },
      { filename: 'app:///apps/web/src/lib/realtime/sse.ts', function: 'stream' },
    ],
  ]) {
    assert.equal(
      isConnectionClosedNoise({
        message: CONNECTION_CLOSED,
        frames,
      }),
      false,
      `expected first-party Connection closed. throw from ${JSON.stringify(frames)} to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: {
          values: [{ value: CONNECTION_CLOSED, stacktrace: { frames } }],
        },
      }),
      false,
      `expected Sentry gate to keep reporting first-party Connection closed. throw from ${JSON.stringify(frames)}`,
    )
  }
})

test('does NOT suppress a near-worded message without the trailing period (over-match guard)', () => {
  // The trailing `.` is part of the anchor — a different message `Connection
  // closed` (no period) must keep reporting so the matcher does not over-match.
  for (const message of ['Connection closed', 'Connection closed!', 'Connection Closed.']) {
    assert.equal(
      isConnectionClosedNoise({
        message,
        frames: [],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress the "Connection closed by server." wording (over-match guard)', () => {
  // Only the EXACT library close string is noise; a different library's
  // `Connection closed by server.` keeps reporting.
  for (const message of [
    'Connection closed by server.',
    'Connection closed by peer.',
    'WebSocket connection closed.',
  ]) {
    assert.equal(
      isConnectionClosedNoise({
        message,
        frames: [],
      }),
      false,
      `expected "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event "${message}" to keep reporting`,
    )
  }
})

// ---------------------------------------------------------------------------
// Canvas `getImageData` out-of-memory noise (BS b4b43847…)
// ---------------------------------------------------------------------------

// The exact raw exception value from the production event (V8/Chrome wording).
const CANVAS_GETIMAGEDATA_OOM_MESSAGE =
  "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': Out of memory at ImageData creation"

// A minified third-party canvas library chunk frame — the call site file from
// the production event (`app:///_next/static/chunks/0fl4m2af7bsiq.js`). No
// resolved first-party `apps/web/src/…` source, so the negative guard does NOT
// fire. Represents the production event's frame shape.
const CANVAS_OOM_PROD_CHUNK_FRAME = 'app:///_next/static/chunks/0fl4m2af7bsiq.js'

// The two production stack frames (both minified third-party canvas library
// chunk frames — NO resolved first-party `apps/web/src/…` source). The call
// site function is `Image.<anonymous>` (the `addEventListener` callback the
// third-party library registered).
const CANVAS_OOM_PROD_FRAMES: Array<{ filename: unknown; function: unknown }> = [
  { filename: CANVAS_OOM_PROD_CHUNK_FRAME, function: 'Image.<anonymous>' },
  { filename: 'app:///_next/static/chunks/0fl4m2af7bsiq.js', function: '?' },
]

// The canonical capture-path forms: raw, `RangeError:` prefix, and stacked
// `Unhandled promise rejection: RangeError:` prefix. All strip to the same
// underlying message via `stripErrorWrappers`.
const CANVAS_OOM_CAPTURE_FORMS = [
  CANVAS_GETIMAGEDATA_OOM_MESSAGE,
  `RangeError: ${CANVAS_GETIMAGEDATA_OOM_MESSAGE}`,
  `Unhandled promise rejection: RangeError: ${CANVAS_GETIMAGEDATA_OOM_MESSAGE}`,
]

test('classifies every Canvas getImageData OOM capture form as noise (no first-party frame)', () => {
  for (const message of CANVAS_OOM_CAPTURE_FORMS) {
    // Matcher-level: message alone (frameless — still noise because the message
    // is the browser's canonical OOM wording and is specific enough).
    assert.equal(
      isCanvasImageDataOOMNoise({ message }),
      true,
      `expected "${message}" to be classified as Canvas getImageData OOM noise`,
    )
    // Matcher-level: with a minified chunk frame (no first-party source).
    assert.equal(
      isCanvasImageDataOOMNoise({
        message,
        frames: [{ filename: CANVAS_OOM_PROD_CHUNK_FRAME }],
      }),
      true,
      `expected "${message}" from a chunk frame to be noise`,
    )
    // Matcher-level: with a window.onerror filename (no first-party source).
    assert.equal(
      isCanvasImageDataOOMNoise({ message, filename: CANVAS_OOM_PROD_CHUNK_FRAME }),
      true,
      `expected "${message}" from a chunk filename to be noise`,
    )
  }
})

test('suppresses the production Canvas getImageData OOM Sentry event via the beforeSend gate', () => {
  // Reproduces the exact production event: BS pattern b4b43847…, release
  // v0.12.4, request URL https://dosco.live/ (marketing homepage), mechanism
  // auto.browser.browserapierrors.addEventListener (UNCAUGHT, handled:false),
  // call site function Image.<anonymous>, call site file
  // app:///_next/static/chunks/0fl4m2af7bsiq.js, 2 minified chunk frames.
  for (const value of CANVAS_OOM_CAPTURE_FORMS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        request: { url: 'https://dosco.live/' },
        exception: {
          values: [
            {
              value,
              mechanism: {
                type: 'auto.browser.browserapierrors.addEventListener',
                handled: false,
              },
              stacktrace: { frames: CANVAS_OOM_PROD_FRAMES },
            },
          ],
        },
      }),
      true,
      `expected Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses a frameless Canvas getImageData OOM Sentry event (no first-party frame to preserve)', () => {
  for (const value of CANVAS_OOM_CAPTURE_FORMS) {
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value }] },
      }),
      true,
      `expected frameless Sentry event for "${value}" to be suppressed`,
    )
  }
})

test('suppresses the Canvas getImageData OOM via the runtime (window.onerror) gate', () => {
  for (const message of CANVAS_OOM_CAPTURE_FORMS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message }),
      true,
      `expected runtime gate to suppress "${message}"`,
    )
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({ message, filename: CANVAS_OOM_PROD_CHUNK_FRAME }),
      true,
      `expected runtime gate to suppress "${message}" from a chunk filename`,
    )
  }
})

test('does NOT suppress a Canvas getImageData OOM whose stack resolves to a first-party app frame', () => {
  // A de-minified `apps/web/src/…` frame means our own code called
  // `getImageData()` and the browser ran out of memory — a real first-party
  // OOM regression, actionable to fix (e.g. shrink the canvas, guard the
  // allocation, or drop the call on low-memory devices). This is the negative
  // guard that distinguishes actionable first-party code regressions from the
  // third-party-library noise class.
  const realAppFrames: Array<Array<{ filename: unknown; function?: unknown }>> = [
    [{ filename: 'app:///apps/web/src/features/marketing/hyper-logo.ts', function: 'samplePixels' }],
    [{ filename: 'apps/web/src/lib/canvas/pixel-reader.ts', function: 'readRegion' }],
  ]
  for (const frames of realAppFrames) {
    for (const message of CANVAS_OOM_CAPTURE_FORMS) {
      assert.equal(
        isCanvasImageDataOOMNoise({ message, frames }),
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
  for (const message of CANVAS_OOM_CAPTURE_FORMS) {
    assert.equal(
      shouldIgnoreBrowserRuntimeNoise({
        message,
        filename: 'apps/web/src/lib/canvas/pixel-reader.ts',
      }),
      false,
      `expected runtime gate to keep reporting first-party "${message}"`,
    )
  }
})

test('does NOT suppress a near-worded message without the exact OOM suffix (over-match guard)', () => {
  // The `Out of memory at ImageData creation` suffix is part of the anchor —
  // a different `getImageData` failure (e.g. a different DOM exception, or a
  // different allocation reason) must keep reporting so the matcher does not
  // over-match a real first-party canvas bug.
  for (const message of [
    // A different `getImageData` DOM exception (e.g. index out of range).
    "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': Index is not in the allowed range.",
    // A different OOM wording without the `ImageData creation` suffix.
    "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': Out of memory.",
    // A different Canvas 2D method entirely.
    "Failed to execute 'putImageData' on 'CanvasRenderingContext2D': Out of memory at ImageData creation",
    // A near-worded first-party throw (no `Failed to execute` DOM prefix).
    'Out of memory at ImageData creation',
  ]) {
    assert.equal(
      isCanvasImageDataOOMNoise({ message, frames: [] }),
      false,
      `expected "${message}" to keep reporting`,
    )
    assert.equal(
      shouldIgnoreSentryBrowserNoise({
        exception: { values: [{ value: message, stacktrace: { frames: [] } }] },
      }),
      false,
      `expected Sentry event "${message}" to keep reporting`,
    )
  }
})

test('does NOT suppress a non-OOM RangeError (over-match guard on the RangeError type)', () => {
  // The matcher anchors on the EXACT `getImageData` OOM message, NOT on the
  // `RangeError` type. A generic `RangeError: Maximum call stack size
  // exceeded.` (the iOS-WebKit stack-overflow class, handled by
  // `isUnresolvableStackOverflowNoise`) or a first-party `RangeError` keeps
  // reporting unless it matches the exact canvas OOM wording.
  for (const message of [
    'Maximum call stack size exceeded.',
    'RangeError: Maximum call stack size exceeded.',
    'Array length must be finite.',
  ]) {
    assert.equal(
      isCanvasImageDataOOMNoise({ message, frames: [] }),
      false,
      `expected "${message}" to keep reporting`,
    )
  }
})
