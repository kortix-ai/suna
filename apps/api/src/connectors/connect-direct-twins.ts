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

const withTwin = (item: unknown, field: string, values: ReadonlyMap<string, string>) =>
  item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
    ? { ...item, [field]: values.get(appNameKey((item as { name: string }).name)) ?? null }
    : item;

/**
 * A managed-catalogue response with `directId` on every app: the API/MCP
 * catalogue id of the same app, or `null`. Walks the listing arrays the
 * managed routes return (a page, or browse sections) and nothing else.
 */
export function withDirectIds(result: unknown, ids: ReadonlyMap<string, string>): unknown {
  return withTwinField(result, 'directId', ids);
}

/**
 * A managed-catalogue response with `directMcpUrl` on every app: the app's
 * hosted MCP server, or `null`. Install offers it before the managed app.
 */
export function withDirectMcpUrls(result: unknown, urls: ReadonlyMap<string, string>): unknown {
  return withTwinField(result, 'directMcpUrl', urls);
}

function withTwinField(
  result: unknown,
  field: string,
  ids: ReadonlyMap<string, string>,
): unknown {
  if (!result || typeof result !== 'object') return result;
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const key of LISTING_KEYS) {
    if (Array.isArray(out[key]))
      out[key] = (out[key] as unknown[]).map((item) => withTwin(item, field, ids));
  }
  if (Array.isArray(out.sections)) {
    // Pipedream sections hold `items`; Composio sections hold `toolkits`.
    out.sections = (out.sections as unknown[]).map((section) => {
      if (!section || typeof section !== 'object') return section;
      const next: Record<string, unknown> = { ...(section as Record<string, unknown>) };
      for (const key of ['items', 'toolkits'] as const) {
        if (Array.isArray(next[key]))
          next[key] = (next[key] as unknown[]).map((item) => withTwin(item, field, ids));
      }
      return next;
    });
  }
  return out;
}
