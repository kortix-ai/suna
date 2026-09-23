/**
 * SVG is never previewed on mobile (Jay, 2026-09-22).
 *
 * A vector renders at any size, so a phone-sized preview says nothing a file
 * card does not, and the renderers treat it as an image — a blob fetch that
 * cannot be copied. The app offers the two things that are useful instead:
 * **Download** and **Copy** (an SVG is text, so it pastes into a design tool
 * or an editor).
 *
 * Applies to the transcript's `show` row (no still in the leading slot) and to
 * the file sheet (the file card as the body, Copy in the title row).
 */

export function isSvgName(name: string): boolean {
  return /\.svg$/i.test(name.trim());
}
