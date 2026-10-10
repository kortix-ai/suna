/**
 * One app, two ways to connect: a managed App (Composio, Pipedream) and the
 * app's own API/MCP server. The two catalogues name apps independently, so
 * they are joined by a normalized name: `Linear`, `Linear MCP` and `linear`
 * are one app.
 */

/** The join key: lower case, letters and digits only, a trailing "MCP" dropped. */
export function appNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(mcp|mcpserver)$/, '');
}

const LISTING_KEYS = ['apps', 'toolkits', 'items', 'popular'] as const;

const withId = (item: unknown, ids: ReadonlyMap<string, string>) =>
  item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
    ? { ...item, directId: ids.get(appNameKey((item as { name: string }).name)) ?? null }
    : item;

/**
 * A managed-catalogue response with `directId` on every app: the API/MCP
 * catalogue id of the same app, or `null`. Walks the listing arrays the
 * managed routes return (a page, or browse sections) and nothing else.
 */
export function withDirectIds(result: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (!result || typeof result !== 'object') return result;
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const key of LISTING_KEYS) {
    if (Array.isArray(out[key]))
      out[key] = (out[key] as unknown[]).map((item) => withId(item, ids));
  }
  if (Array.isArray(out.sections)) {
    out.sections = (out.sections as unknown[]).map((section) =>
      section &&
      typeof section === 'object' &&
      Array.isArray((section as { items?: unknown }).items)
        ? {
            ...section,
            items: (section as { items: unknown[] }).items.map((item) => withId(item, ids)),
          }
        : section,
    );
  }
  return out;
}
