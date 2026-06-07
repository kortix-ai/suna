const KNOWN_BROWSER_NOISE_MESSAGES = [
  'Invalid call to runtime.sendMessage(). Tab not found.',
  "document.querySelector('video').webkitPresentationMode",
  'webkitPresentationMode',
  'MetaMask extension not found',
  'Looks like your website URL has changed',
  'CookieYes account',
] as const;

const KNOWN_TEST_NOISE_MESSAGES = [
  'E2E FINAL:',
  'E2E test:',
] as const;

// Frozen-intrinsics noise: some hardened wallet / privacy browser extensions
// (MetaMask "lockdown"/SES, Rabby, Pocket Universe, etc.) call
// `Object.freeze(Promise.prototype)` (and other intrinsics) to harden the page
// *before* our app's JavaScript runs. When Next.js's bundled
// `react-server-dom-webpack/client` (the RSC Flight runtime) then initializes
// its internal `Chunk` thenable with `Chunk.prototype.then = function () {…}`,
// the assignment to the now read-only inherited `then` throws:
//
//   TypeError: Cannot assign to read only property 'then' of object '#<Promise>'
//
// The throwing frame is our own bundle (`app:///_next/static/chunks/…`), not an
// `extension://` URL, so the extension-source filter below never sees it. This
// is uncontrollable third-party-extension damage with no actionable fix on our
// side, so we suppress it explicitly. See vercel/next.js#78823.
//
// The exact wording varies by engine and by which intrinsic the extension froze
// ('then', 'push', etc.), so we match the stable, distinctive substrings rather
// than a single full message.
const FROZEN_INTRINSICS_NOISE_MARKERS = [
  'Cannot assign to read only property',
  'Attempted to assign to readonly property',
] as const;

const KNOWN_DOM_MUTATION_NOISE_MESSAGES = [
  "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
  "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
] as const;

const KNOWN_HYDRATION_NOISE_MESSAGES = [
  'Minified React error #418',
  "Hydration failed because the server rendered",
] as const;

const EXTENSION_PROTOCOL_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://',
  'extension://',
] as const;

const INJECTED_APP_SOURCE_PATTERNS = [
  /^app:\/\/\/scripts\/inpage\.js$/,
  /^app:\/\/\/client_data\/[^/]+\/script\.js$/,
] as const;

function containsKnownPattern(message: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    return normalizeString((value as { message?: unknown }).message);
  }
  return '';
}

// A read-only-assignment TypeError is only noise when it targets a frozen JS
// *intrinsic* (Promise/RSC `Chunk`) rather than one of our own objects — that
// signature is the wallet/SES extension hardening the page (see
// FROZEN_INTRINSICS_NOISE_MARKERS above). Requiring the `'then'` target keeps
// genuine app bugs (e.g. writing to our own `Object.freeze`'d state) reportable.
export function isFrozenIntrinsicsNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return (
    containsKnownPattern(normalized, FROZEN_INTRINSICS_NOISE_MARKERS) &&
    normalized.includes("'then'")
  );
}

export function isKnownBrowserNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return (
    containsKnownPattern(normalized, KNOWN_BROWSER_NOISE_MESSAGES) ||
    isFrozenIntrinsicsNoiseMessage(normalized)
  );
}

export function isExtensionSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return EXTENSION_PROTOCOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isInjectedAppSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return INJECTED_APP_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isKnownTestNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, KNOWN_TEST_NOISE_MESSAGES);
}

export function isLikelyDomMutationNoise(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, KNOWN_DOM_MUTATION_NOISE_MESSAGES)
    || containsKnownPattern(normalized, KNOWN_HYDRATION_NOISE_MESSAGES);
}

export function shouldIgnoreBrowserRuntimeNoise(input: {
  message?: unknown;
  filename?: unknown;
  error?: unknown;
  reason?: unknown;
}): boolean {
  const message = [input.message, extractMessage(input.error), extractMessage(input.reason)]
    .find((value) => Boolean(value)) ?? '';

  if (isKnownBrowserNoiseMessage(message)) {
    return true;
  }

  if (isKnownTestNoiseMessage(message)) {
    return true;
  }

  if (isInjectedAppSource(input.filename)) {
    return true;
  }

  return isExtensionSource(input.filename) && normalizeString(message).includes('runtime.sendMessage');
}

export function shouldIgnoreSentryBrowserNoise(event: {
  message?: unknown;
  request?: { url?: unknown };
  exception?: {
    values?: Array<{
      value?: unknown;
      stacktrace?: { frames?: Array<{ filename?: unknown }> };
    }>;
  };
}): boolean {
  const primaryException = event.exception?.values?.find(Boolean);
  const message = primaryException?.value ?? event.message;
  const frames = primaryException?.stacktrace?.frames ?? [];
  const requestUrl = normalizeString(event.request?.url);
  const environment = normalizeString((event as { environment?: unknown }).environment);

  if (isKnownBrowserNoiseMessage(message)) {
    return true;
  }

  if (isKnownTestNoiseMessage(message)) {
    return true;
  }

  if (environment === 'test' || environment.startsWith('e2e')) {
    return true;
  }

  if (frames.some((frame) => isInjectedAppSource(frame.filename))) {
    return true;
  }

  if (frames.some((frame) => isExtensionSource(frame.filename))) {
    return true;
  }

  if (isLikelyDomMutationNoise(message) && requestUrl.includes('/auth')) {
    return true;
  }

  return requestUrl.includes('/auth') && normalizeString(message).includes('runtime.sendMessage');
}

export function shouldIgnoreSentryNoiseEvent(event: {
  message?: unknown;
  environment?: unknown;
  request?: { url?: unknown };
  exception?: {
    values?: Array<{
      value?: unknown;
      stacktrace?: { frames?: Array<{ filename?: unknown }> };
    }>;
  };
}): boolean {
  return shouldIgnoreSentryBrowserNoise(event);
}
