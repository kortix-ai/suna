/** Proposed slugs for a new custom connector. */

/**
 * Slugify the source document's own name — OpenAPI `info.title`, Postman
 * `info.name` — so adding a spec proposes the slug the API calls itself
 * ("Kortix WhatsApp Gateway" → `kortix-whatsapp-gateway`). Derived from the
 * document first: a hostname is a guess, a title is a statement.
 */
export function slugFromTitle(title: string | null | undefined): string {
  return (title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/**
 * The fallback when the source names nothing (an MCP server answers 401
 * before it says its name): the host's brand label, so
 * `https://api.acmenotes.ai/connect/mcp` proposes `acmenotes`.
 */
export function slugFromUrl(url: string | null | undefined): string {
  let host: string;
  try {
    host = new URL((url ?? '').trim()).hostname;
  } catch {
    return '';
  }
  const labels = host.split('.');
  if (labels.length > 1) labels.pop();
  // A second-level suffix (`example.co.uk`) is not the brand either.
  if (labels.length > 1 && /^(co|com|org|net|ac|gov)$/.test(labels.at(-1)!)) labels.pop();
  const brand = labels.filter((label) => !/^(www|api|mcp|app|server)$/.test(label)).at(-1);
  return slugFromTitle(brand ?? labels.at(-1));
}
