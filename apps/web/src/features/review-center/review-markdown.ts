/**
 * Markdown detection for free-form review-item descriptions (the thin
 * Change-Request adapter payload carries whatever prose the agent wrote).
 * Pure + conservative: plain multi-line text — including simple `-` bullet
 * lists — must NOT match, so those keep the designed per-line checkmark
 * treatment; only clear markdown syntax switches the modal to a real
 * markdown render.
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
