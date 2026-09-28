import type { NoiseRule } from '../evidence';
import { containsKnownPattern, isBrowserBundleSource, normalizeString } from '../evidence';

const KNOWN_BROWSER_NOISE_MESSAGES = [
  'Invalid call to runtime.sendMessage(). Tab not found.',
  "document.querySelector('video').webkitPresentationMode",
  'webkitPresentationMode',
  'MetaMask extension not found',
  'Looks like your website URL has changed',
  'CookieYes account',
  // Third-party injected scripts / extensions / scanner bots that monkey-patch
  // native Promise internals (e.g. `promise.then = ...`). The native Promise
  // prototype is read-only, so the assignment throws a TypeError that surfaces
  // via onunhandledrejection — it is never our code. Seen from headless
  // tech-detection crawlers hitting the marketing site.
  "Cannot assign to read only property 'then' of object '#<Promise>'",
  'Cannot assign to read only property',
] as const;

const KNOWN_TEST_NOISE_MESSAGES = ['E2E FINAL:', 'E2E test:'] as const;

function isBareImageLoadNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return normalized === 'Failed to load image' || normalized === 'Error: Failed to load image';
}

export function isKnownBrowserNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, KNOWN_BROWSER_NOISE_MESSAGES);
}

export function isKnownTestNoiseMessage(message: unknown): boolean {
  const normalized = normalizeString(message);
  return containsKnownPattern(normalized, KNOWN_TEST_NOISE_MESSAGES);
}

export const MESSAGE_RULES: readonly NoiseRule[] = [
  {
    id: 'known-browser-message',
    appliesTo: 'both',
    match: ({ message }) => isKnownBrowserNoiseMessage(message),
  },
  {
    id: 'test-message',
    appliesTo: 'both',
    match: ({ message }) => isKnownTestNoiseMessage(message),
  },
  {
    // Events the Sentry SDK tags with a `test` / `e2e*` environment.
    id: 'test-environment',
    appliesTo: 'sentry',
    match: ({ environment }) => environment === 'test' || environment.startsWith('e2e'),
  },
  {
    // Browser-native <img> / next/image load failures can surface as this exact
    // message through window.onerror. Keep this exact: the old pptx-react-viewer
    // threw actionable errors such as "Failed to load image for colour change
    // processing", which must still reach error tracking.
    id: 'image-load',
    appliesTo: 'runtime',
    match: ({ message }) => isBareImageLoadNoiseMessage(message),
  },
  {
    // The Sentry gate also runs in the server and edge Sentry configs. Require a
    // browser bundle frame here so a same-worded server exception is not hidden.
    // The client config additionally has an anchored ignoreErrors regex for
    // frame-less browser events.
    id: 'image-load-bundle-frame',
    appliesTo: 'sentry',
    match: ({ message, frames }) =>
      isBareImageLoadNoiseMessage(message) &&
      frames.some((frame) => isBrowserBundleSource(frame?.filename)),
  },
];
