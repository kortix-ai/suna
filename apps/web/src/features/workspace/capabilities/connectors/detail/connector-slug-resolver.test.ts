import { describe, expect, test } from 'bun:test';

import { appResolutionQueries } from './connector-slug-resolver';

describe('appResolutionQueries — how a connector finds its app', () => {
  test('leads with the prefix tokens a contains-search can actually match', () => {
    // "Canva" contains neither "Canva MCP server" nor "canva-mcp-server-x",
    // so the FULL strings alone never find the app — the first-word and
    // first-segment candidates are what land.
    expect(
      appResolutionQueries({ slug: 'canva-mcp-server-xe9gxn', name: 'Canva MCP server' }),
    ).toEqual(['Canva', 'canva', 'Canva MCP server', 'canva-mcp-server-xe9gxn']);
  });

  test('single-word connectors collapse to their own tokens', () => {
    expect(appResolutionQueries({ slug: 'github', name: 'GitHub' })).toEqual(['GitHub', 'github']);
  });

  test('too-short prefix tokens are dropped; the full strings survive', () => {
    expect(appResolutionQueries({ slug: 'x-api', name: 'X API' })).toEqual(['X API', 'x-api']);
  });
});
