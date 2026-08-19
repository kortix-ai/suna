// Every hot environment push must use the same LLM gateway URL formula as boot.
import { beforeEach, describe, expect, test } from 'bun:test';

process.env.KORTIX_URL = 'https://api.example.com';
process.env.FRONTEND_URL = 'https://app.example.com';
delete process.env.LLM_GATEWAY_BASE_URL;
delete process.env.LLM_GATEWAY_PROXY_PORT;
delete process.env.LLM_GATEWAY_PROXY_TARGET;

const { config } = await import('../../config');
const { llmGatewayBaseUrlForProvider } = await import('./sandbox-env-sync');

describe('llmGatewayBaseUrlForProvider', () => {
  beforeEach(() => {
    config.LLM_GATEWAY_BASE_URL = '';
    config.LLM_GATEWAY_PROXY_PORT = 0;
    config.LLM_GATEWAY_PROXY_TARGET = '';
  });

  test('uses the public config.KORTIX_URL for every provider', () => {
    expect(llmGatewayBaseUrlForProvider('daytona')).toBe('https://api.example.com/v1/llm');
    expect(llmGatewayBaseUrlForProvider('e2b')).toBe('https://api.example.com/v1/llm');
    expect(llmGatewayBaseUrlForProvider('platinum')).toBe('https://api.example.com/v1/llm');
  });

  test('an explicit LLM_GATEWAY_BASE_URL override wins for every provider', () => {
    config.LLM_GATEWAY_BASE_URL = 'https://gateway.internal.example.com/v1/llm';
    expect(llmGatewayBaseUrlForProvider('daytona')).toBe(
      'https://gateway.internal.example.com/v1/llm',
    );
  });
});
