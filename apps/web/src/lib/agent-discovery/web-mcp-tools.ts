import { MARKDOWN_ROUTE_PATHS } from './markdown-negotiation';

export type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

// `WEB_MCP_TOOLS` registers on every route via the root layout, including
// authenticated ones, and runs in the visitor's own browser — so `fetch`
// carries their real session cookies (default `credentials: 'same-origin'`).
// A path-taking tool must never be allowed to reach anything other than the
// generated public markdown routes, or it becomes a credentialed same-origin
// page reader for any WebMCP-capable agent that can supply tool input.
const ALLOWED_MARKDOWN_PATHS = new Set(MARKDOWN_ROUTE_PATHS);

/**
 * Root-relative check is defence in depth on top of the allowlist: without it
 * a value like `https://evil.com` or `//evil.com` would still fail the Set
 * lookup, but we reject it here first so the reason is unambiguous and the
 * allowlist never has to reason about non-path input.
 */
function isRootRelativePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//');
}

function assertAllowedMarkdownPath(path: string): string | undefined {
  if (!isRootRelativePath(path)) {
    return `"${path}" is not a root-relative page path. Pass a path like /pricing, not a full URL.`;
  }
  if (!ALLOWED_MARKDOWN_PATHS.has(path)) {
    return `"${path}" is not a public Kortix page. Call list_kortix_pages to see valid paths.`;
  }
  return undefined;
}

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
      'Fetch one of the public Kortix pages as markdown instead of HTML. Pass a root-relative ' +
      'path from list_kortix_pages, e.g. /pricing — paths outside the public page set are rejected.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Root-relative public page path.' } },
      required: ['path'],
    },
    execute: async (input) => {
      const path = String(input.path ?? '/');
      const rejection = assertAllowedMarkdownPath(path);
      // A rejection is a normal tool result, not a thrown error: an agent that
      // gets a text explanation can retry with a valid path, whereas a thrown
      // error or a silent empty string gives it nothing to act on.
      if (rejection) return { error: rejection };
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
