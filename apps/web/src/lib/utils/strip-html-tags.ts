/**
 * Strip HTML-like tags from plain text (e.g. for search labels and previews).
 * Loops until stable so nested/overlapping tag patterns cannot re-form `<script>`.
 */
export function stripHtmlTags(text: string): string {
  let previous = '';
  let current = text;
  while (current !== previous) {
    previous = current;
    current = current.replace(/<[^>]+>/g, '');
  }
  return current;
}
