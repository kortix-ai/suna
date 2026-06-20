/**
 * Robustly extract display text from a shared message part.
 *
 * A part's `content` is loosely typed (it may be a plain string, a
 * `{ text }` object, or an array of either, depending on the source message),
 * so the previous `part.content?.text` silently dropped string/array content.
 * Handle each shape explicitly instead.
 */
function partContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partContentToText).join('');
  if (content && typeof content === 'object' && 'text' in content) {
    const t = (content as { text?: unknown }).text;
    return typeof t === 'string' ? t : '';
  }
  return '';
}

export function partToText(part: { text?: string; content?: unknown }): string {
  if (typeof part.text === 'string' && part.text) return part.text;
  return partContentToText(part.content);
}
