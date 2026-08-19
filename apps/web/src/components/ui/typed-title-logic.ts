/**
 * When a title should type itself in.
 *
 * Pure, and separate from the component, because this is the whole decision —
 * the rendering is a detail. A session title types when its VALUE CHANGES, not
 * when it renders. That distinction is what keeps the effect off the frequency
 * cliff: a page load, a scroll back up, a re-sort of the list and a re-render
 * from unrelated state all paint titles instantly, because none of them change
 * a title. Twenty rows typing at once on load would be noise; this cannot
 * produce it.
 */

/** How long between characters. A fast, confident typist — slow enough to read
 *  as typing, quick enough that a 40-character title lands in ~1.4s. Shared by
 *  every surface so the effect is one thing, not per-list guesswork. */
export const TYPE_SPEED_MS = 36;

export function shouldTypeOnChange({
  previous,
  next,
  reduceMotion,
}: {
  /** What this row last displayed. `null` means it has never displayed
   *  anything — the very first render. */
  previous: string | null;
  next: string;
  reduceMotion: boolean;
}): boolean {
  // First render is never an animation. The row is appearing with whatever the
  // title already is; there was no change to show, and animating here is what
  // would make a cold page load type twenty titles at once.
  if (previous === null) return false;
  if (previous === next) return false;
  // Reduced motion still gets the new title — instantly. Typing is decoration
  // over a value that is already correct, so removing it costs nothing; a fade
  // would be the compromise if the motion carried meaning, and it does not.
  if (reduceMotion) return false;
  // An empty title has nothing to type. Guarded because the animation would
  // otherwise complete on an empty string and leave the cursor blinking on a
  // row with no text.
  return next.length > 0;
}
