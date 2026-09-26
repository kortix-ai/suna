import { describe, expect, test } from 'bun:test';

import { connectorIconFace } from './connector-icon-face';

describe('connectorIconFace', () => {
  test('shows the logo the API resolved, for every provider', () => {
    for (const provider of ['composio', 'pipedream', 'openapi', 'mcp', 'channel'] as const) {
      expect(
        connectorIconFace({ provider, platform: null, iconUrl: 'https://logos.test/app.png' }),
      ).toEqual({ kind: 'image', src: 'https://logos.test/app.png' });
    }
  });

  test('a Slack channel without a stored logo wears the Slack mark, not a chat bubble', () => {
    expect(connectorIconFace({ provider: 'channel', platform: 'slack', iconUrl: null })).toEqual({
      kind: 'slack',
    });
  });

  test('falls back to the provider glyph when no logo is known', () => {
    expect(connectorIconFace({ provider: 'composio', platform: null, iconUrl: null })).toEqual({
      kind: 'glyph',
      glyph: 'app',
    });
    expect(connectorIconFace({ provider: 'openapi', iconUrl: undefined })).toEqual({
      kind: 'glyph',
      glyph: 'web',
    });
    expect(connectorIconFace({ provider: 'mcp', iconUrl: '  ' })).toEqual({
      kind: 'glyph',
      glyph: 'mcp',
    });
    expect(connectorIconFace({ provider: 'channel', platform: 'email', iconUrl: null })).toEqual({
      kind: 'glyph',
      glyph: 'email',
    });
    expect(connectorIconFace({ provider: 'computer', iconUrl: null })).toEqual({
      kind: 'glyph',
      glyph: 'computer',
    });
  });
});
