import { describe, expect, test } from 'bun:test';

import { mcpServerFor } from './mcp-first';

const linear = { name: 'Linear', directMcpUrl: 'https://mcp.linear.app/mcp' };

describe('mcpServerFor: Install connects through the app’s own MCP server when it is one click', () => {
  test('a one-click MCP server is the way to connect', async () => {
    const checked: string[] = [];
    const server = await mcpServerFor('p1', linear, async (projectId, url) => {
      checked.push(`${projectId} ${url}`);
      return { requires_sign_in: true, one_click: true };
    });
    expect(server).toEqual({ name: 'Linear', url: 'https://mcp.linear.app/mcp' });
    expect(checked).toEqual(['p1 https://mcp.linear.app/mcp']);
  });

  test('a server without one-click sign-in keeps the managed app', async () => {
    expect(
      await mcpServerFor('p1', linear, async () => ({ requires_sign_in: true, one_click: false })),
    ).toBeNull();
  });

  test('an app with no MCP server asks nothing', async () => {
    let asked = false;
    const server = await mcpServerFor('p1', { name: 'Mural', directMcpUrl: null }, async () => {
      asked = true;
      return { requires_sign_in: true, one_click: true };
    });
    expect(server).toBeNull();
    expect(asked).toBe(false);
  });

  test('a check that fails keeps the managed app', async () => {
    expect(
      await mcpServerFor('p1', linear, async () => {
        throw new Error('offline');
      }),
    ).toBeNull();
  });
});
