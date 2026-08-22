import { afterEach, describe, expect, test } from 'bun:test';

import imageSearch from '../../templates/base/.kortix/opencode/tools/image_search';
import scrapeWebpage from '../../templates/base/.kortix/opencode/tools/scrape_webpage';
import webSearch from '../../templates/base/.kortix/opencode/tools/web_search';

const originalFetch = globalThis.fetch;
const originalEnv = {
  KORTIX_API_URL: process.env.KORTIX_API_URL,
  KORTIX_SANDBOX_TOKEN: process.env.KORTIX_SANDBOX_TOKEN,
};

function configureRouterEnv() {
  process.env.KORTIX_API_URL = 'https://api.kortix.test/v1';
  process.env.KORTIX_SANDBOX_TOKEN = 'kortix_sb_test';
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

  test('image enrichment preserves the Serper and Replicate router contracts', async () => {
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
      if (call === 2) {
        expect(String(input)).toBe('https://images.kortix.test/logo.png');
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      }

      expect(String(input)).toBe('https://api.kortix.test/v1/router/replicate/predictions');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer kortix_sb_test');
      const body = JSON.parse(String(init?.body));
      expect(body.version).toBe('72ccb656353c348c1385df54b237eeb7bfa874bf11486cf0b9473e691b662d31');
      expect(body.input.prompt).toContain('Describe this image');
      expect(body.input.image).toStartWith('data:image/png;base64,');
      return Response.json({ status: 'succeeded', output: 'A black Kortix logo.' });
    }) as typeof fetch;

    const output = await imageSearch.execute(
      { query: 'Kortix', num_results: 1, enrich: true },
      {} as never,
    );
    const result = JSON.parse(String(output));

    expect(call).toBe(3);
    expect(result.images[0].description).toBe('A black Kortix logo.');
  });
});
