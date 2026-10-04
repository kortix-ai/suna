/**
 * Render a drizzle SQL object to its flat statement text: chunks joined in
 * order, params and column names inlined. The turn-lifecycle suites assert
 * against this text, so both files must render identically.
 */
export function renderSql(query: unknown): string {
  if (query === null || query === undefined) return '';
  if (typeof query !== 'object') return String(query);
  const node = query as { queryChunks?: unknown[]; value?: unknown; name?: unknown };
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(renderSql).join(' ');
  if (Array.isArray(node.value)) return node.value.join('');
  if (node.value !== undefined) return String(node.value);
  if (node.name !== undefined) return String(node.name);
  return '';
}
