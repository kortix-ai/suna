export type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Every tool is read-only, unauthenticated, and backed by an endpoint that
 * already exists. Nothing here mutates state: a page-level agent surface is the
 * wrong place to expose writes.
 */
export const WEB_MCP_TOOLS: WebMcpTool[] = [
  {
    name: 'search_kortix_docs',
    description: 'Search the Kortix product documentation and return matching sections.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
    },
    execute: async (input) => {
      const query = String(input.query ?? '');
      const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
      return response.json();
    },
  },
  {
    name: 'list_kortix_pages',
    description:
      'List public Kortix pages with titles, descriptions and last-modified dates. Paginated.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['marketing', 'blog', 'docs', 'use-case'],
          description: 'Restrict to one content family.',
        },
        cursor: { type: 'string', description: 'Opaque cursor from a previous call.' },
      },
    },
    execute: async (input) => {
      const params = new URLSearchParams();
      if (input.kind) params.set('kind', String(input.kind));
      if (input.cursor) params.set('cursor', String(input.cursor));
      const query = params.toString();
      const response = await fetch(`/api/ai${query ? `?${query}` : ''}`);
      return response.json();
    },
  },
  {
    name: 'get_kortix_page_markdown',
    description:
      'Fetch any public Kortix page as markdown instead of HTML. Pass the page path, e.g. /pricing.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Root-relative page path.' } },
      required: ['path'],
    },
    execute: async (input) => {
      const path = String(input.path ?? '/');
      const response = await fetch(path, { headers: { Accept: 'text/markdown' } });
      return response.text();
    },
  },
  {
    name: 'get_kortix_pricing',
    description: 'Return the current Kortix pricing plans as markdown.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const response = await fetch('/pricing', { headers: { Accept: 'text/markdown' } });
      return response.text();
    },
  },
];

type ModelContextHost = {
  modelContext?: {
    provideContext: (context: { tools: WebMcpTool[] }) => { unregister?: () => void } | undefined;
  };
};

/**
 * Registers the tools with a WebMCP host and returns a cleanup function.
 * Returns undefined when the browser has no WebMCP support, so callers stay
 * inert rather than throwing.
 */
export function registerWebMcpTools(target: unknown): (() => void) | undefined {
  const host = target as ModelContextHost | null;
  const provideContext = host?.modelContext?.provideContext;
  if (typeof provideContext !== 'function') return undefined;

  const registration = provideContext.call(host!.modelContext, { tools: WEB_MCP_TOOLS });
  return () => registration?.unregister?.();
}
