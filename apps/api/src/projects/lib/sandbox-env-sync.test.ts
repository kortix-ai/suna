// Regression for the "hot push undoes the boot-time fix" class of bug: every
// call site here that pushes KORTIX_LLM_BASE_URL to a RUNNING sandbox
// (syncSandboxEnvForPrompt on every prompt, propagateLlmGatewayModeToActiveSandboxes
// on a project's gateway-mode toggle) must resolve it onto the SAME per-provider
// origin session-sandbox.ts uses at boot — not a second, hardcoded-to-the-public-
// origin copy. That second copy is exactly how local-docker's KORTIX_LLM_BASE_URL
// fix got silently undone by the very next prompt (see local-docker.test.ts and
// llm-gateway/sandbox-base-url.test.ts for the formula itself).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';

process.env.KORTIX_URL = 'https://api.example.com';
process.env.FRONTEND_URL = 'https://app.example.com';
delete process.env.LLM_GATEWAY_BASE_URL;
delete process.env.LLM_GATEWAY_PROXY_PORT;
delete process.env.LLM_GATEWAY_PROXY_TARGET;

// Fakes a same-machine provider (only local-docker implements this today) vs.
// every remote cloud provider, which omits sandboxFacingApiOrigin entirely.
mock.module('../../platform/providers', () => ({
  getProvider: (name: string) =>
    name === 'local-docker'
      ? { sandboxFacingApiOrigin: () => 'http://kortix-api:8008' }
      : {},
}));

const { config } = await import('../../config');
const { buildEnvSyncHeaders, llmGatewayBaseUrlForProvider } = await import('./sandbox-env-sync');

describe('buildEnvSyncHeaders', () => {
  test('keeps provider ingress credentials but strips user context from the internal env route', () => {
    const headers = buildEnvSyncHeaders({
      providerHeaders: {
        'X-Daytona-Preview-Token': 'provider-token',
        [KORTIX_USER_CONTEXT_HEADER.toLowerCase()]: 'signed-user-context',
        Authorization: 'Bearer user-scoped-value',
      },
      serviceKey: 'sandbox-service-key',
    });

    expect(headers.get('X-Daytona-Preview-Token')).toBe('provider-token');
    expect(headers.get(KORTIX_USER_CONTEXT_HEADER)).toBeNull();
    expect(headers.get('Authorization')).toBe('Bearer sandbox-service-key');
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});

describe('llmGatewayBaseUrlForProvider', () => {
  beforeEach(() => {
    config.LLM_GATEWAY_BASE_URL = '';
    config.LLM_GATEWAY_PROXY_PORT = 0;
    config.LLM_GATEWAY_PROXY_TARGET = '';
  });

  test('local-docker: resolves onto the Docker-network origin, not the generic public KORTIX_URL', () => {
    expect(llmGatewayBaseUrlForProvider('local-docker')).toBe('http://kortix-api:8008/v1/llm');
  });

  test('a remote cloud provider (no sandboxFacingApiOrigin): falls back to the generic public config.KORTIX_URL', () => {
    expect(llmGatewayBaseUrlForProvider('daytona')).toBe('https://api.example.com/v1/llm');
    expect(llmGatewayBaseUrlForProvider('e2b')).toBe('https://api.example.com/v1/llm');
    expect(llmGatewayBaseUrlForProvider('platinum')).toBe('https://api.example.com/v1/llm');
  });

  test('an explicit LLM_GATEWAY_BASE_URL override wins for every provider, same-machine or not', () => {
    config.LLM_GATEWAY_BASE_URL = 'https://gateway.internal.example.com/v1/llm';
    expect(llmGatewayBaseUrlForProvider('local-docker')).toBe(
      'https://gateway.internal.example.com/v1/llm',
    );
    expect(llmGatewayBaseUrlForProvider('daytona')).toBe(
      'https://gateway.internal.example.com/v1/llm',
    );
  });
});
