import { describe, expect, test } from 'bun:test';

import { slugFromTitle, slugFromUrl } from './connector-slug';

describe('slugFromUrl: the slug a pasted server URL proposes', () => {
  const cases: Array<[string, string]> = [
    ['https://api.acmenotes.ai/connect/mcp', 'acmenotes'],
    ['https://mcp.linear.app/mcp', 'linear'],
    ['https://mcp.notion.com/mcp', 'notion'],
    ['https://www.example.com/openapi.json', 'example'],
    ['http://localhost:3001/mcp', 'localhost'],
    ['https://api.example.co.uk/graphql', 'example'],
  ];
  test('takes the brand label of the host', () => {
    for (const [url, slug] of cases) expect([url, slugFromUrl(url)]).toEqual([url, slug]);
  });

  test('a half-typed or empty URL proposes nothing', () => {
    expect(slugFromUrl('https://')).toBe('');
    expect(slugFromUrl('acme')).toBe('');
    expect(slugFromUrl(undefined)).toBe('');
  });

  test('a title still wins where the source has one', () => {
    expect(slugFromTitle('Kortix WhatsApp Gateway')).toBe('kortix-whatsapp-gateway');
  });
});
