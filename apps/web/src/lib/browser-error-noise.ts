const KNOWN_BROWSER_NOISE_MESSAGES = [
  'Invalid call to runtime.sendMessage(). Tab not found.',
  "document.querySelector('video').webkitPresentationMode",
  'webkitPresentationMode',
] as const;

const EXTENSION_PROTOCOL_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://',
  'extension://',
  'app:///',
] as const;

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
  return KNOWN_BROWSER_NOISE_MESSAGES.some((pattern) => normalized.includes(pattern));
}

export function isExtensionSource(filename: unknown): boolean {
  const normalized = normalizeString(filename);
  return EXTENSION_PROTOCOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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

  if (isKnownBrowserNoiseMessage(message)) {
    return true;
  }

  if (frames.some((frame) => isExtensionSource(frame.filename))) {
    return true;
  }

  return requestUrl.includes('/auth') && normalizeString(message).includes('runtime.sendMessage');
}
