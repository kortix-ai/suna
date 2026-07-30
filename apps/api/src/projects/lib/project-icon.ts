/**
 * Validator for `projects.metadata.icon` — the per-project emoji shown on the
 * project card.
 *
 * Every write path (provision / create-repo / link-repository) and the read
 * path (serializeProject) run values through this one function, so a value that
 * reached the column can always be rendered.
 *
 * Returning `null` means "no icon". It never throws: a malformed icon must not
 * fail project creation, because the icon is decoration and the project is not.
 */

/** Comfortably above the longest RGI emoji sequence. `👩🏽‍❤️‍💋‍👨🏿` alone is 35 bytes,
 *  so a 32-byte cap would reject a value the picker can produce. */
const MAX_ICON_BYTES = 64;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const encoder = new TextEncoder();

export function normalizeProjectIcon(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Cheap bound first: without it a 5 KB string reaches the segmenter, and it
  // would land in the jsonb column and render straight into ProjectCard.
  if (encoder.encode(trimmed).length > MAX_ICON_BYTES) return null;

  // Exactly one grapheme cluster. Intl.Segmenter treats skin-tone modifiers,
  // ZWJ sequences, and tag flags as one cluster, so `👨‍👩‍👧‍👦` passes and `🚀🚀` does not.
  let count = 0;
  for (const _ of graphemes.segment(trimmed)) {
    count += 1;
    if (count > 1) return null;
  }
  if (count !== 1) return null;

  // One grapheme is not enough on its own — `A` is one grapheme too.
  if (!/\p{Extended_Pictographic}/u.test(trimmed)) return null;

  return trimmed;
}
