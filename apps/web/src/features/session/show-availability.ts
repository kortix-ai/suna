/**
 * Availability gating for `show` tool cards.
 *
 * A `show` tool call points at an artifact — a generated file, an image, a
 * rendered iframe preview, etc. Artifacts get renamed, regenerated, or deleted
 * as a session progresses, so a `show` from earlier in the run can end up
 * pointing at something that no longer loads (a 404'd file, an unhealthy
 * preview). Rather than render a broken "File not found" card for these dead
 * references, the renderer hides them entirely and only keeps the `show` cards
 * whose content actually loaded.
 *
 * This module holds the pure decision used by `ShowTool`, kept separate so it
 * can be unit-tested without rendering the (async, data-fetching) tree.
 */

/** Load status reported up from a show's single-item content renderer. */
export type ShowLoadStatus = 'loading' | 'ready' | 'error';

export interface ShowAvailabilityInput {
  /** The tool part is still streaming/producing — the artifact may not exist yet. */
  running: boolean;
  /** Multi-item carousel — manages its own per-item state, never hidden wholesale. */
  isCarousel: boolean;
  /** Status reported by the single-item file/media content renderer. */
  contentStatus: ShowLoadStatus;
  /** This show renders an embedded website/file iframe preview. */
  isWebsitePreview: boolean;
  /** The iframe preview failed to load (errored or timed out). */
  previewHasError: boolean;
  /** The preview is an intentional link-only fallback (a card, not a failure). */
  previewIsLinkOnly: boolean;
}

/**
 * Decide whether a single-item `show` card should be hidden because its
 * underlying artifact failed to load.
 *
 * Rules:
 *  - While the tool is still running, never hide — the file may still be
 *    materializing, and a transient 404 shouldn't make the card flicker away.
 *  - Carousels are never hidden wholesale (they navigate between items).
 *  - A website/iframe preview is hidden only when it actually errored AND it
 *    isn't a deliberate link-only fallback.
 *  - Otherwise the card is hidden when its file/media content errored (e.g. the
 *    file was renamed or deleted → 404).
 */
export function isShowContentUnavailable(input: ShowAvailabilityInput): boolean {
  const {
    running,
    isCarousel,
    contentStatus,
    isWebsitePreview,
    previewHasError,
    previewIsLinkOnly,
  } = input;

  if (running || isCarousel) return false;
  if (isWebsitePreview) return previewHasError && !previewIsLinkOnly;
  return contentStatus === 'error';
}
