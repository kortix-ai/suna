import { afterEach, describe, expect, test } from 'bun:test';

import imageSearch from '../../templates/base/.kortix/opencode/tools/image_search';
import scrapeWebpage from '../../templates/base/.kortix/opencode/tools/scrape_webpage';
import webSearch from '../../templates/base/.kortix/opencode/tools/web_search';

const originalFetch = globalThis.fetch;
const originalEnv = {
  KORTIX_API_URL: process.env.KORTIX_API_URL,
  KORTIX_TOKEN: process.env.KORTIX_TOKEN,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
};

function configureRouterEnv() {
  process.env.KORTIX_API_URL = 'https://api.kortix.test/v1';
  process.env.KORTIX_TOKEN = 'kortix_sb_test';
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('OpenCode provider tools', () => {
  test('web search preserves the Tavily router request and response contract', async () => {
    configureRouterEnv();
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('https://api.kortix.test/v1/router/tavily/search');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer kortix_sb_test');
      expect(JSON.parse(String(init?.body))).toEqual({
        query: 'latest Kortix release',
        search_depth: 'advanced',
        topic: 'news',
        max_results: 7,
        include_answer: true,
        include_images: true,
        include_image_descriptions: true,
      });
      return Response.json({
        answer: 'Kortix shipped.',
        response_time: 0.42,
        results: [
          {
            title: 'Release',
            url: 'https://kortix.test/release',
            content: 'Release notes',
            score: 0.9,
            published_date: '2026-08-20',
          },
        ],
        images: [{ url: 'https://kortix.test/image.png', description: 'Logo' }],
      });
    }) as typeof fetch;

    const output = await webSearch.execute(
      {
        query: 'latest Kortix release',
        num_results: 7,
        topic: 'news',
        search_depth: 'advanced',
      },
      {} as never,
    );
    const result = JSON.parse(String(output));

    expect(result).toMatchObject({
      query: 'latest Kortix release',
      success: true,
      answer: 'Kortix shipped.',
      response_time_ms: 0.42,
      results: [
        {
          title: 'Release',
          url: 'https://kortix.test/release',
          snippet: 'Release notes',
          score: 0.9,
          published_date: '2026-08-20',
        },
      ],
    });
  });

  test('explicit Parallel selection uses MCP discovery and returns cited excerpts without Tavily credentials', async () => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.KORTIX_API_URL;
    delete process.env.KORTIX_TOKEN;
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('https://search.parallel.ai/mcp');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('User-Agent')).toBe('Kortix');
      expect(new Headers(init?.headers).get('Authorization')).toBeNull();
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      if (request.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'parallel-fixture', version: '1' },
            }
          : request.method === 'tools/list'
            ? { tools: [{ name: 'web_search', inputSchema: { type: 'object' } }] }
            : (() => {
                expect(request.method).toBe('tools/call');
                expect(request.params).toEqual({
                  name: 'web_search',
                  arguments: {
                    objective: 'Kortix release',
                    search_queries: ['Kortix release'],
                  },
                });
                return {
                  structuredContent: {
                    results: [
                      {
                        title: 'Release notes',
                        url: 'https://kortix.test/release',
                        excerpts: ['Version details'],
                        publish_date: '2026-09-01',
                      },
                    ],
                  },
                  content: [],
                };
              })();
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch;

    const output = await webSearch.execute({ query: 'Kortix release', provider: 'parallel' }, {
      sessionID: 'ses_test_123',
    } as never);
    expect(JSON.parse(String(output))).toEqual({
      query: 'Kortix release',
      provider: 'parallel',
      success: true,
      results: [
        {
          title: 'Release notes',
          url: 'https://kortix.test/release',
          snippet: 'Version details',
          published_date: '2026-09-01',
        },
      ],
      warnings: [],
    });
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
  });

  test('Parallel rejects Tavily-only controls before making a request', async () => {
    globalThis.fetch = (() => {
      throw new Error('unexpected fetch');
    }) as unknown as typeof fetch;
    expect(
      await webSearch.execute(
        { query: 'Kortix', provider: 'parallel', topic: 'news' },
        {} as never,
      ),
    ).toContain('Parallel does not support topic or search_depth');
  });

  test('Parallel reports MCP tool errors instead of empty search results', async () => {
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'parallel-fixture', version: '1' },
            }
          : request.method === 'tools/list'
            ? { tools: [{ name: 'web_search', inputSchema: { type: 'object' } }] }
            : { isError: true, content: [{ type: 'text', text: 'rate limited' }] };
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch;
    const output = JSON.parse(
      String(await webSearch.execute({ query: 'Kortix', provider: 'parallel' }, {} as never)),
    );
    expect(output).toMatchObject({ success: false, provider: 'parallel' });
    expect(output.error).toContain('rate limited');
  });

  test('Parallel reports an empty response as no result', async () => {
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'parallel-fixture', version: '1' },
            }
          : request.method === 'tools/list'
            ? { tools: [{ name: 'web_search', inputSchema: { type: 'object' } }] }
            : { structuredContent: { results: [] }, content: [] };
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch;

    const output = JSON.parse(
      String(await webSearch.execute({ query: 'unfindable', provider: 'parallel' }, {} as never)),
    );
    expect(output).toMatchObject({ query: 'unfindable', success: false, results: [] });
  });

  test('Parallel batch connection failure preserves the batch response shape', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection unavailable');
    }) as unknown as typeof fetch;

    const output = JSON.parse(
      String(
        await webSearch.execute({ query: 'first ||| second', provider: 'parallel' }, {} as never),
      ),
    );
    expect(output).toMatchObject({
      batch_mode: true,
      total_queries: 2,
      results: [
        { query: 'first', success: false, provider: 'parallel' },
        { query: 'second', success: false, provider: 'parallel' },
      ],
    });
  });

  test('scrape preserves the Firecrawl v2 router contract', async () => {
    configureRouterEnv();
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('https://api.kortix.test/v1/router/firecrawl/v2/scrape');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer kortix_sb_test');
      expect(JSON.parse(String(init?.body))).toEqual({
        url: 'https://kortix.test/docs',
        formats: ['markdown', 'html'],
        timeout: 30000,
      });
      return Response.json({
        success: true,
        data: {
          markdown: '# Kortix',
          html: '<h1>Kortix</h1>',
          metadata: { title: 'Kortix Docs' },
        },
      });
    }) as typeof fetch;

    const output = await scrapeWebpage.execute(
      { urls: 'https://kortix.test/docs', include_html: true },
      {} as never,
    );

    expect(JSON.parse(String(output))).toEqual({
      url: 'https://kortix.test/docs',
      success: true,
      title: 'Kortix Docs',
      content: '# Kortix',
      content_length: 8,
      html: '<h1>Kortix</h1>',
      metadata: { title: 'Kortix Docs' },
    });
  });

  test('image search preserves the Serper router contract without enrichment calls', async () => {
    configureRouterEnv();
    let call = 0;
    globalThis.fetch = (async (input, init) => {
      call += 1;
      if (call === 1) {
        expect(String(input)).toBe('https://api.kortix.test/v1/router/serper/images');
        expect(JSON.parse(String(init?.body))).toEqual({ q: 'Kortix', num: 1 });
        return Response.json({
          images: [
            {
              imageUrl: 'https://images.kortix.test/logo.png',
              title: 'Kortix',
              link: 'https://kortix.test',
              imageWidth: 100,
              imageHeight: 100,
            },
          ],
        });
      }
      throw new Error(`unexpected image-search request: ${String(input)}`);
    }) as typeof fetch;

    const output = await imageSearch.execute({ query: 'Kortix', num_results: 1 }, {} as never);
    const result = JSON.parse(String(output));

    expect(call).toBe(1);
    expect(result.images[0]).toEqual({
      url: 'https://images.kortix.test/logo.png',
      title: 'Kortix',
      source: 'https://kortix.test',
      width: 100,
      height: 100,
    });
  });
});
