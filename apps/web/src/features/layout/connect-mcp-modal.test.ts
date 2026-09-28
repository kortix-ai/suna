import { describe, expect, test } from 'bun:test';
import { cursorInstallUrl, mcpUrl } from './connect-mcp-modal';

describe('mcpUrl', () => {
  test('is the one account-level MCP endpoint under the API /v1 mount', () => {
    expect(mcpUrl('https://api.kortix.com/v1')).toBe('https://api.kortix.com/v1/mcp');
    expect(mcpUrl('https://dev-api.kortix.com/v1/')).toBe('https://dev-api.kortix.com/v1/mcp');
    expect(mcpUrl('http://localhost:8008')).toBe('http://localhost:8008/v1/mcp');
  });
});

describe('cursorInstallUrl', () => {
  test('carries the URL as base64 JSON config', () => {
    const url = mcpUrl('https://api.kortix.com/v1');
    const link = new URL(cursorInstallUrl(url));
    expect(link.searchParams.get('name')).toBe('kortix');
    expect(JSON.parse(atob(link.searchParams.get('config')!))).toEqual({ url });
  });
});
