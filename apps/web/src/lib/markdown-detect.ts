/**
 * Does this free-form text actually contain markdown syntax?
 *
 * Pure + deliberately conservative: plain multi-line text — including simple
 * `-` bullet lists — must NOT match. Callers use a false result to keep their
 * own plain-text treatment (review-center's per-line checkmarks, a tool's
 * monospace output block), so a false positive silently replaces a designed
 * rendering with a generic one. Only unambiguous syntax counts.
 */

const MD_SIGNALS: RegExp[] = [
  /^#{1,6}\s+\S/m, // ATX heading: "## What this changes"
  /```/, // fenced code block
  /\*\*[^*\n]+\*\*/, // bold
  /(^|[^`])`[^`\n]+`([^`]|$)/, // inline code span (not a fence)
  /\[[^\]\n]+\]\([^)\n]+\)/, // [link](url)
  /^\s*\d+\.\s+\S/m, // ordered list: "1. step"
];

export function looksLikeMarkdown(text: string): boolean {
  return MD_SIGNALS.some((re) => re.test(text));
}
