// resolveLlmGatewayBaseUrl is the ONE formula both session-sandbox.ts (boot)
// and projects/lib/sandbox-env-sync.ts (hot env-push) must share — a second,
// hand-rolled copy at either call site is exactly how local-docker's
// KORTIX_LLM_BASE_URL fix got silently undone by the very next prompt (the
// hot-push path kept computing the generic public origin). These tests pin
// down the formula in isolation so a future edit can't drift the two call
// sites apart again.
import { beforeEach, describe, expect, test } from 'bun:test';

process.env.KORTIX_URL = 'https://api.example.com';
process.env.FRONTEND_URL = 'https://app.example.com';
delete process.env.LLM_GATEWAY_BASE_URL;
delete process.env.LLM_GATEWAY_PROXY_PORT;
delete process.env.LLM_GATEWAY_PROXY_TARGET;

const { config } = await import('../config');
const { resolveLlmGatewayBaseUrl } = await import('./sandbox-base-url');

describe('resolveLlmGatewayBaseUrl', () => {
  beforeEach(() => {
    config.LLM_GATEWAY_BASE_URL = '';
    config.LLM_GATEWAY_PROXY_PORT = 0;
    config.LLM_GATEWAY_PROXY_TARGET = '';
  });

  test('default (no proxy mode): {origin}/v1/llm', () => {
    expect(resolveLlmGatewayBaseUrl('https://api.example.com')).toBe(
      'https://api.example.com/v1/llm',
    );
  });

  test('strips a trailing slash off the origin before appending the suffix', () => {
    expect(resolveLlmGatewayBaseUrl('https://api.example.com/')).toBe(
      'https://api.example.com/v1/llm',
    );
  });

  test('local-docker-style origin (Docker network DNS) round-trips the same way', () => {
    expect(resolveLlmGatewayBaseUrl('http://kortix-api:8008')).toBe(
      'http://kortix-api:8008/v1/llm',
    );
  });

  test('proxy mode (LLM_GATEWAY_PROXY_PORT set): {origin}/v1/llm-gateway/v1/llm', () => {
    config.LLM_GATEWAY_PROXY_PORT = 8090;
    expect(resolveLlmGatewayBaseUrl('http://kortix-api:8008')).toBe(
      'http://kortix-api:8008/v1/llm-gateway/v1/llm',
    );
  });

  test('proxy mode via LLM_GATEWAY_PROXY_TARGET (K8s-style) takes the same branch', () => {
    config.LLM_GATEWAY_PROXY_TARGET = 'llm-gateway:8090';
    expect(resolveLlmGatewayBaseUrl('https://api.example.com')).toBe(
      'https://api.example.com/v1/llm-gateway/v1/llm',
    );
  });

  test('an explicit LLM_GATEWAY_BASE_URL override always wins, regardless of origin', () => {
    config.LLM_GATEWAY_BASE_URL = 'https://gateway.internal.example.com/v1/llm';
    expect(resolveLlmGatewayBaseUrl('http://kortix-api:8008')).toBe(
      'https://gateway.internal.example.com/v1/llm',
    );
  });
});
