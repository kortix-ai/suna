/**
 * Prepares React Native's globals for MathJax. Import this before any
 * `@mathjax/src` module.
 *
 * React Native defines `window.navigator` as `{ product: 'ReactNative' }`, with
 * no `appVersion` or `userAgent`. MathJax's `util/context.js` reads both while
 * its module loads (`navigator.appVersion.includes('Win')`), so without strings
 * there the import throws "Cannot read property 'includes' of undefined" and
 * every screen that renders chat markdown fails to load.
 *
 * Empty strings match no OS name, so MathJax's `context.os` resolves to
 * 'unknown'; MathJax only uses it for keyboard labels, which the app never shows.
 */
const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;

if (nav && typeof nav === 'object') {
  if (typeof nav.appVersion !== 'string') nav.appVersion = '';
  if (typeof nav.userAgent !== 'string') nav.userAgent = '';
}

export {};
