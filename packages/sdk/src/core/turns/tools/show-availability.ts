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

// ═══════════════════════════════════════════════════════════════════════════
// Emptiness — a different question from availability
// ═══════════════════════════════════════════════════════════════════════════
//
// The gate above answers "the artifact failed to load"; that failure is worth a
// line in the transcript, because the agent DID hand something over and the
// reference went dead.
//
// This one answers "there was never an artifact at all". The show tool
// validates its own arguments (`packages/starter/templates/base/.kortix/
// opencode/tools/show.ts`) and returns a plain `Error: 'content' is required…`
// string when a required field is missing — but the tool part still carries the
// arguments the model sent, so the renderer happily draws a card for
// `{ type: 'markdown' }`: a header reading "Output", and under it nothing at
// all. Every branch of `ShowContentRenderer` is guarded on `content`/`path`, so
// the cascade falls through to a fallback whose four sub-conditions are all
// false, and the body renders as an empty box.
//
// A card with no body is not a deliverable, so it does not get a row.

/** True for a string that carries something. Blank strings are absence. */
function isFilled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The three fields a `show` can carry an artifact in.
 *
 * `title`, `description`, `type`, `language` and `aspect_ratio` are metadata
 * ABOUT an artifact — never one themselves. A `show` holding only those has
 * nothing to render.
 */
function hasShowArtifact(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const { path, url, content } = payload as Record<string, unknown>;
  return isFilled(path) || isFilled(url) || isFilled(content);
}

/**
 * `items` reaches the UI as EITHER an array or a JSON string — the model
 * serializes it and nothing downstream normalizes that before it lands in
 * `state.input`. Both `ShowTool` and the Outputs derivation already handle both
 * shapes; this parses defensively for the same reason.
 *
 * Malformed or half-streamed JSON yields `null`, which pushes the caller back
 * onto the single-item fields. That is safe because emptiness is only ever
 * judged on a SETTLED call — a mid-stream fragment is never the final answer.
 */
function parseShowItemsPayload(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw.length > 0 ? raw : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True when a `show` has no artifact to render — no `items`, no `path`, no
 * `url`, no `content`.
 *
 * A carousel is empty only when NONE of its items carries an artifact; one good
 * item keeps the whole carousel, since paging is how the rest are reached.
 */
export function isShowPayloadEmpty(input: Record<string, unknown> | null | undefined): boolean {
  if (!input) return true;
  const items = parseShowItemsPayload(input.items);
  if (items) return !items.some(hasShowArtifact);
  return !hasShowArtifact(input);
}
