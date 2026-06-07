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

const KNOWN_DOM_MUTATION_NOISE_MESSAGES = [
  "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
  "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
] as const;

const KNOWN_HYDRATION_NOISE_MESSAGES = [
  'Minified React error #418',
  "Hydration failed because the server rendered",
] as const;

// Third-party-script / browser-extension interference: an injected script (a
// wallet/translation/ad-block extension, a tag-manager snippet, etc.) freezes
// `Promise.prototype` or redefines `then`/`catch`/`finally` as non-writable.
// Framework code (Next.js' RSC client / router, Sentry's event pipeline) then
// throws while attaching one of those handlers to a *native* Promise. This is
// not an application bug — it originates entirely outside our bundle — so it is
// pure noise. The wording differs per JS engine, hence the multiple patterns.
const FROZEN_PROMISE_HANDLER_PROPERTIES = ['then', 'catch', 'finally'] as const;

function buildFrozenPromiseNoisePatterns(): RegExp[] {
  const props = FROZEN_PROMISE_HANDLER_PROPERTIES.join('|');
  return [
    // V8 / Chrome / Node: Cannot assign to read only property 'then' of object '#<Promise>'
    new RegExp(`read[ -]?only property '(?:${props})' of object '#<Promise>'`, 'i'),
    // SpiderMonkey / Firefox: "then" is read-only
    new RegExp(`"(?:${props})" is read-only`, 'i'),
    // JavaScriptCore / Safari: Attempted to assign to readonly property 'then'.
    new RegExp(`assign to read[ -]?only property '(?:${props})'`, 'i'),
  ];
}

const FROZEN_PROMISE_NOISE_PATTERNS = buildFrozenPromiseNoisePatterns();

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

export function isKnownBrowserNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, KNOWN_BROWSER_NOISE_MESSAGES);
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

/**
 * True when the message is the "cannot assign a Promise handler" signature that
 * a third-party script / browser extension produces by freezing the native
 * Promise (e.g. `Cannot assign to read only property 'then' of object
 * '#<Promise>'`). Matched across Chrome/V8, Firefox and Safari wordings, and
 * restricted to the `then`/`catch`/`finally` handlers so genuine read-only
 * property bugs in app objects are not swallowed.
 */
export function isFrozenPromiseInteropNoise(message: unknown): boolean {
  const normalized = normalizeString(message);
  if (!normalized) return false;
  return FROZEN_PROMISE_NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
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

  if (isFrozenPromiseInteropNoise(message)) {
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

  if (isFrozenPromiseInteropNoise(message)) {
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
