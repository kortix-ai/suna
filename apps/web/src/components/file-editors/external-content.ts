/**
 * What an open editor shows after the persisted file changed underneath it.
 *
 * Returns the content to adopt, or `null` to keep what is on screen. `saved` is
 * the persisted content the editor knew BEFORE this change: comparing against
 * the new one instead makes every unedited editor look edited, which is how it
 * used to freeze on the old text behind an "unsaved changes" mark.
 */
export function contentAfterExternalChange({
  local,
  saved,
  next,
  readOnly,
  justSaved,
}: {
  /** What the editor shows now. */
  local: string;
  /** The persisted content before this change. */
  saved: string;
  /** The persisted content now. */
  next: string;
  readOnly: boolean;
  /** Inside the post-save window, where a refetch may still serve the old bytes. */
  justSaved: boolean;
}): string | null {
  if (local === next) return null;
  if (readOnly) return next;
  if (justSaved) return null;
  return local === saved ? next : null;
}
