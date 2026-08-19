/**
 * JSON.stringify for embedding inside an HTML `<script>` tag. Escapes the
 * characters that could terminate the tag or break the surrounding markup
 * (`<`, `>`, `&`) plus the JS line separators U+2028/U+2029, using JSON
 * string escapes so the output parses identically with JSON.parse or as a
 * JS expression.
 */
export function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
