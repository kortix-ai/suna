/**
 * Programmatic smooth-scroll that tolerates non-scrollable targets.
 *
 * `.scrollTo()` exists on `Element` / `HTMLElement` in modern browsers, but a
 * ref can resolve to a value that lacks it — `null`, a plain object, a
 * component instance, or a DOM node in an edge runtime / stripped WebView.
 * Calling `.scrollTo()` on such a value throws
 * `TypeError: t.scrollTo is not a function`, which surfaces in production
 * (Better Stack) on the marketing homepage when the interactive-demo tab strip
 * is touched mid-render.
 *
 * Every programmatic `.scrollTo()` aimed at a ref / resolved element must go
 * through here so a non-scrollable target is a silent no-op instead of a throw.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTo
 */
export function safeScrollTo(
  el: { scrollTo?: (opts?: ScrollToOptions) => void } | null | undefined,
  options?: ScrollToOptions,
): void {
  if (el && typeof el.scrollTo === 'function') {
    el.scrollTo(options);
  }
}
