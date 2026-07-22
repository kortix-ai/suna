import { describe, expect, mock, test } from 'bun:test';

import { WEB_MCP_TOOLS, registerWebMcpTools } from './web-mcp-tools';

describe('web mcp tool definitions', () => {
  test('exposes the four read-only site capabilities', () => {
    expect(WEB_MCP_TOOLS.map((tool) => tool.name).sort()).toEqual([
      'get_kortix_page_markdown',
      'get_kortix_pricing',
      'list_kortix_pages',
      'search_kortix_docs',
    ]);
  });

  test('every tool carries a description, a JSON Schema and an executor', () => {
    for (const tool of WEB_MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  test('search forwards the query to the existing docs search endpoint', async () => {
    // Typed params (not `mock(async () => ...)`) so `.mock.calls[n]` matches how
    // fetch is actually invoked below — see api-client.test.ts for the same idiom.
    const fetchMock = mock(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify([{ id: 'x' }])),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const search = WEB_MCP_TOOLS.find((tool) => tool.name === 'search_kortix_docs')!;
      await search.execute({ query: 'sessions' });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/search?query=sessions');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('page markdown negotiates on the page path rather than guessing a URL', async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('# Pricing'),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const tool = WEB_MCP_TOOLS.find((t) => t.name === 'get_kortix_page_markdown')!;
      const result = await tool.execute({ path: '/pricing' });
      expect(fetchMock.mock.calls[0][0]).toBe('/pricing');
      // Cast, matching api-client.test.ts's convention for reading a HeadersInit
      // union back out of a mocked fetch call.
      expect((fetchMock.mock.calls[0][1]!.headers as Record<string, string>).Accept).toBe(
        'text/markdown',
      );
      expect(result).toBe('# Pricing');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('registerWebMcpTools', () => {
  test('is inert when the browser has no WebMCP support', () => {
    expect(registerWebMcpTools({})).toBeUndefined();
  });

  test('provides the tools and returns a cleanup function', () => {
    const unregister = mock(() => {});
    // Typed param so `.mock.calls[0][0]` below isn't a zero-length tuple.
    const provideContext = mock((_context: { tools: unknown[] }) => ({ unregister }));
    const cleanup = registerWebMcpTools({ modelContext: { provideContext } });

    expect(provideContext).toHaveBeenCalledTimes(1);
    expect(provideContext.mock.calls[0][0].tools).toHaveLength(WEB_MCP_TOOLS.length);

    cleanup?.();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test('survives a registration that returns nothing to unregister', () => {
    const cleanup = registerWebMcpTools({ modelContext: { provideContext: () => undefined } });
    expect(() => cleanup?.()).not.toThrow();
  });
});
