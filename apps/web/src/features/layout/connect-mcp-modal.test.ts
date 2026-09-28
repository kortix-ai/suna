import { describe, expect, test } from 'bun:test';
import { cursorInstallUrl, mcpUrl } from './connect-mcp-modal';

const PROJECT = '00000000-0000-4000-a000-000000000001';

describe('mcpUrl', () => {
  test('is the project MCP endpoint under the API /v1 mount', () => {
    expect(mcpUrl('https://api.kortix.com/v1', PROJECT)).toBe(`https://api.kortix.com/v1/projects/${PROJECT}/mcp`);
    expect(mcpUrl('https://dev-api.kortix.com/v1/', PROJECT)).toBe(`https://dev-api.kortix.com/v1/projects/${PROJECT}/mcp`);
    expect(mcpUrl('http://localhost:8008', PROJECT)).toBe(`http://localhost:8008/v1/projects/${PROJECT}/mcp`);
  });
});

describe('cursorInstallUrl', () => {
  test('carries the URL as base64 JSON config', () => {
    const url = mcpUrl('https://api.kortix.com/v1', PROJECT);
    const link = new URL(cursorInstallUrl(url));
    expect(link.searchParams.get('name')).toBe('kortix');
    expect(JSON.parse(atob(link.searchParams.get('config')!))).toEqual({ url });
  });
});
