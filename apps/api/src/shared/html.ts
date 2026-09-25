/**
 * The API's one HTML escaper. It escapes `& < > " '`, so its output is safe in
 * element text and in single- or double-quoted attribute values. It does not
 * make a value safe inside a `<script>` or `<style>` block, or in an unquoted
 * attribute.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
