import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { runWithContext } from '../lib/request-context';

mock.module('../config', () => ({
  KORTIX_MARKUP: 1.2,
  config: {
    TAVILY_API_KEY: 'tvly-test',
    TAVILY_API_URL: 'https://api.tavily.test',
    SERPER_API_KEY: 'serper-test',
    SERPER_API_URL: 'https://google.serper.test',
    OPENROUTER_API_KEY: 'openrouter-test',
    OPENROUTER_API_URL: 'https://openrouter.test/api/v1',
    FRONTEND_URL: 'https://kortix.test',
  },
}));

const { webSearchTavily } = await import('../router/services/tavily');
const { imageSearchSerper } = await import('../router/services/serper');

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
};

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    if (url === 'https://api.tavily.test/search') {
      return json({ results: [{ title: 'Result', url: 'https://example.test', content: 'Snippet' }] });
    }

    if (url === 'https://google.serper.test/images') {
      return json({ images: [{ title: 'Image', imageUrl: 'https://example.test/image.png', link: 'https://example.test' }] });
    }

    return new Response('unexpected test URL', { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('router provider trace propagation', () => {
  test('forwards normalized trace headers to web and image search providers', async () => {
    await runWithContext(
      'POST',
      '/v1/router/web-search',
      async () => {
        await webSearchTavily('kortix', 2);
        await imageSearchSerper('kortix', 2);
      },
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    );

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.tavily.test/search',
      'https://google.serper.test/images',
    ]);
    for (const call of calls) {
      expect(call.headers.traceparent).toMatch(/^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-[0-9a-f]{16}-01$/);
      expect(call.headers.traceparent).not.toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
      expect(call.headers['x-request-id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    }
  });

});
