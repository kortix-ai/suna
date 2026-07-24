/**
 * `NoCompactionModelError` — the EXPECTED, user-facing configuration state
 * surfaced by the compaction (`useSummarizeOpenCodeSession`) mutation when
 * every model-resolution fallback tier fails (no config default, no assistant
 * message in the thread, no connected provider/model).
 *
 * This is NOT a code defect: the user clicked "Compact" with no model
 * configured anywhere, and the toast already tells them so ("No model
 * available for compaction. Please configure a model in settings."). It must
 * never page Better Stack. Previously thrown as a plain `Error`, it leaked to
 * Sentry as an unhandled promise rejection (the host fires the
 * `loadingToast`-wrapped mutation with `void`, and `loadingToast` re-throws
 * the error after showing the toast → `onunhandledrejection` auto-capture).
 *
 * Promoted to a named, sentinel-marked class (mirroring
 * `RuntimeNotReadyError` in `../../core/runtime/client`) so:
 *   - hosts / the global react-query mutation `onError` can `instanceof` it,
 *   - the Sentry telemetry gate (`apps/web/src/lib/browser-error-noise.ts`)
 *     can match it precisely and drop it across every capture path
 *     (`onunhandledrejection`, `window.onerror`, `ClientErrorBoundary`,
 *     route/system-fault boundaries), and
 *   - a longer real error that merely mentions the wording is never matched
 *     (the gate anchors on this exact message).
 *
 * The `name` + message stay identical to the legacy plain-`Error` throw so
 * any external string-match fallback keeps working.
 */
export class NoCompactionModelError extends Error {
  constructor(
    message = 'No model available for compaction. Please configure a model in settings.',
  ) {
    super(message);
    this.name = 'NoCompactionModelError';
  }
}
