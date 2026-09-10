import { afterEach, describe, expect, test } from 'bun:test';

import { buildHarness, configFromEnv, type WorkerConfig } from './worker.ts';

const KEYS = [
  'KORTIX_API_KEY',
  'KORTIX_GATEWAY_URL',
  'KORTIX_LLM_BASE_URL',
  'KORTIX_TOKEN',
  'KORTIX_MODEL_MODE',
] as const;

const saved = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function realConfig(): WorkerConfig {
  return {
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'test',
    modelMode: 'real',
    sessionId: 'session-real',
  };
}

describe('real model credentials', () => {
  test('a real worker fails boot instead of answering through the faux provider', async () => {
    await expect(buildHarness(realConfig())).rejects.toThrow(
      'real model mode requires a provider API key or a gateway URL with KORTIX_TOKEN',
    );
  });

  test.serial('a session token is never treated as a direct provider key', () => {
    delete process.env.KORTIX_API_KEY;
    delete process.env.KORTIX_GATEWAY_URL;
    delete process.env.KORTIX_LLM_BASE_URL;
    process.env.KORTIX_TOKEN = 'session-token';
    process.env.KORTIX_MODEL_MODE = 'real';

    expect(configFromEnv().apiKey).toBeUndefined();
  });

  test.serial('the session token authenticates only through the configured gateway', () => {
    delete process.env.KORTIX_API_KEY;
    delete process.env.KORTIX_GATEWAY_URL;
    process.env.KORTIX_LLM_BASE_URL = 'https://gateway.example.test/v1';
    process.env.KORTIX_TOKEN = 'session-token';
    process.env.KORTIX_MODEL_MODE = 'real';

    const config = configFromEnv();
    expect(config.gatewayUrl).toBe('https://gateway.example.test/v1');
    expect(config.apiKey).toBe('session-token');
  });
});
