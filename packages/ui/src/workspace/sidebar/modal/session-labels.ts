/** Mirrors `SessionLabelsSchema` in `@kortix/api-contract`: the server refuses anything else. */
export const MAX_SESSION_LABELS = 20;
export const MAX_SESSION_LABEL_LENGTH = 64;

/** Add one typed label. A duplicate is a no-op; an empty draft changes nothing. */
export function addSessionLabel(
  labels: readonly string[],
  draft: string,
): { labels: string[] } | { problem: 'tooLong' | 'tooMany' } {
  const label = draft.trim();
  if (!label || labels.includes(label)) return { labels: [...labels] };
  if (label.length > MAX_SESSION_LABEL_LENGTH) return { problem: 'tooLong' };
  if (labels.length >= MAX_SESSION_LABELS) return { problem: 'tooMany' };
  return { labels: [...labels, label] };
}

export function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}
