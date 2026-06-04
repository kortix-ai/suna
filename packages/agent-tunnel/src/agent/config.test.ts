import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { loadConfig } from './config';

const ENV_KEYS = [
  'TUNNEL_API_URL',
  'TUNNEL_WS_PATH',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('loadConfig', () => {
  it('does not let undefined overrides clear defaults or env config', () => {
    process.env.TUNNEL_API_URL = 'https://relay.example/api?debug=1#token';
    const config = loadConfig({ apiUrl: undefined });

    expect(config.apiUrl).toBe('https://relay.example/api');
  });

  it('rejects non-http API URLs before network use', () => {
    expect(() => loadConfig({ apiUrl: 'file:///tmp/config.json' })).toThrow(
      'Invalid tunnel API URL protocol',
    );
  });

  it('requires the websocket path to be an absolute path', () => {
    expect(loadConfig({ wsPath: '/relay/ws' }).wsPath).toBe('/relay/ws');
    expect(() => loadConfig({ wsPath: 'https://relay.example/ws' })).toThrow(
      'Tunnel WebSocket path must be an absolute path',
    );
  });
});
