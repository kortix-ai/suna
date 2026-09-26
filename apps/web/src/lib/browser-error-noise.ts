// Browser error-noise classification: the one table of noise rules both
// telemetry gates consult.
//
// - `shouldIgnoreBrowserRuntimeNoise` gates `window.onerror`,
//   `unhandledrejection`, and error-boundary captures.
// - `shouldIgnoreSentryBrowserNoise` (via `shouldIgnoreSentryNoiseEvent`) is the
//   Sentry `beforeSend` gate in the client, server, and edge configs.
//
// Each rule lives with its matcher and rationale in `browser-noise/rules/*`.
// To add a noise class, add one rule to the family module that owns it. A
// rule's `appliesTo` names the gates that consult it. Every rule only ever
// says "ignore", so the verdict is an OR over the rules and does not depend on
// their order.

import type { NoiseRule, RuntimeNoiseInput, SentryNoiseEvent } from './browser-noise/evidence';
import { runtimeNoiseEvidence, sentryNoiseEvidence } from './browser-noise/evidence';
import { CHUNK_LOAD_RULES } from './browser-noise/rules/chunk-load';
import { EXPECTED_STATE_RULES } from './browser-noise/rules/expected-states';
import { EXTENSION_RULES } from './browser-noise/rules/extensions';
import { GRAPHICS_RULES } from './browser-noise/rules/graphics';
import { INJECTED_SCRIPT_RULES } from './browser-noise/rules/injected-scripts';
import { MESSAGE_RULES } from './browser-noise/rules/messages';
import { NETWORK_RULES } from './browser-noise/rules/network';
import { OLD_BROWSER_RULES } from './browser-noise/rules/old-browsers';
import { PDF_RULES } from './browser-noise/rules/pdf';
import { REACT_RULES } from './browser-noise/rules/react';
import { REJECTION_RULES } from './browser-noise/rules/rejections';
import { STORAGE_RULES } from './browser-noise/rules/storage';
import { WEBVIEW_RULES } from './browser-noise/rules/webview';

export {
  isEmptyMessageUnresolvedBrowserChunkNoise,
  isStaleWebpackRuntimeCallNoise,
} from './browser-noise/rules/chunk-load';
export {
  isClientRequestTimeoutMessage,
  isExpectedBillingGateMessage,
  isExpectedCompactionNoModelMessage,
  isGitMirrorUnavailableNoiseMessage,
  isModelNotServableNoise,
  isRuntimeNotReadyNoiseMessage,
  isServerDeadlineNoiseMessage,
} from './browser-noise/rules/expected-states';
export {
  isCaptchaInterceptorNoise,
  isExtensionRejectedObjectNoise,
  isExtensionSource,
  isInjectedAppSource,
  isInjectedScriptSendMessageNoise,
  isInpageJsNoErrorMessageNoise,
  isInpageWalletStreamNoise,
  isTronLinkProxyNoise,
  isUserscriptManagerNoise,
} from './browser-noise/rules/extensions';
export {
  isCanvasImageDataOOMNoise,
  isPaperShaderImageUniformNoise,
  isPaperShaderNullContextNoise,
  isPaperShaderWebGLUnsupportedNoise,
} from './browser-noise/rules/graphics';
export {
  isOneTrustJsonParseNoise,
  isRedefineInjectedWalletNoise,
  isRedefineWebdriverNoise,
  isVercelLiveFeedbackNoise,
} from './browser-noise/rules/injected-scripts';
export {
  isKnownBrowserNoiseMessage,
  isKnownTestNoiseMessage,
} from './browser-noise/rules/messages';
export {
  isConnectionClosedNoise,
  isFailedToSendMessageNoise,
  isFramelessNetworkErrorNoise,
  isSignalTimeoutNoise,
} from './browser-noise/rules/network';
export {
  isOldBrowserDomNullDerefNoise,
  isOldBrowserSyntaxParseError,
  isOldWebkitRegexNoiseMessage,
  isUndefinedVariableThirdPartyNoise,
  isUnresolvableStackOverflowNoise,
} from './browser-noise/rules/old-browsers';
export {
  isEmbedPdfTilingReactUpdateDepthNoise,
  isEmbedPdfTilingTileDestructureNoise,
} from './browser-noise/rules/pdf';
export {
  isDocumentStateNotFoundNoise,
  isExpectedNextRecoveryBailoutNoise,
  isFirefoxReactSchedulerReentryNoise,
  isLikelyDomMutationNoise,
  isThirdPartyReactUpdateDepthNoise,
} from './browser-noise/rules/react';
export {
  isNonErrorObjectNotFoundRejectionNoise,
  isNonErrorUndefinedRejectionNoise,
  isOperationErrorPopErrorScopeNoise,
  isSupabaseTokenExpiredNoise,
} from './browser-noise/rules/rejections';
export {
  isSafariGenericSecurityErrorNoise,
  isStorageDisabledWebViewNoiseMessage,
  isStorageSecurityErrorNoise,
} from './browser-noise/rules/storage';
export {
  isAndroidWebViewNativeBridgePostEventNoise,
  isAndroidWebViewNativeBridgePostMessageNoise,
  isIOSWebViewWebKitBridgeNoise,
} from './browser-noise/rules/webview';

export const NOISE_RULES: readonly NoiseRule[] = [
  ...MESSAGE_RULES,
  ...STORAGE_RULES,
  ...EXPECTED_STATE_RULES,
  ...OLD_BROWSER_RULES,
  ...GRAPHICS_RULES,
  ...WEBVIEW_RULES,
  ...CHUNK_LOAD_RULES,
  ...EXTENSION_RULES,
  ...INJECTED_SCRIPT_RULES,
  ...PDF_RULES,
  ...REACT_RULES,
  ...REJECTION_RULES,
  ...NETWORK_RULES,
];

const RUNTIME_RULES = NOISE_RULES.filter((rule) => rule.appliesTo !== 'sentry');
const SENTRY_RULES = NOISE_RULES.filter((rule) => rule.appliesTo !== 'runtime');

export function shouldIgnoreBrowserRuntimeNoise(input: RuntimeNoiseInput): boolean {
  const evidence = runtimeNoiseEvidence(input);
  return RUNTIME_RULES.some((rule) => rule.match(evidence));
}

export function shouldIgnoreSentryBrowserNoise(event: SentryNoiseEvent, hint?: { originalException?: unknown }): boolean {
  const evidence = sentryNoiseEvidence(event, hint);
  return SENTRY_RULES.some((rule) => rule.match(evidence));
}

export function shouldIgnoreSentryNoiseEvent(event: SentryNoiseEvent, hint?: { originalException?: unknown }): boolean {
  return shouldIgnoreSentryBrowserNoise(event, hint);
}
