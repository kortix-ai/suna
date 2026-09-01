import { describe, expect, test } from 'bun:test';

import { connectorSetupSteps, connectorTechnicalRows } from './connector-detail-copy';

describe('connectorSetupSteps', () => {
  test('keeps OAuth terminology for a managed project connector', () => {
    expect(
      connectorSetupSteps({
        provider: 'composio',
        authorizationStrategy: 'project',
        connected: false,
        requestAuthType: 'oauth2',
      }),
    ).toEqual([
      {
        title: 'Start the connection',
        description: 'Open the provider authorization flow from Kortix.',
      },
      {
        title: 'Approve OAuth access',
        description: 'Sign in to the provider and approve the requested account or workspace.',
      },
      {
        title: 'Verify the project connection',
        description: 'Return to Kortix and confirm that the shared account reports Connected.',
      },
    ]);
  });

  test('describes direct MCP credential setup', () => {
    const steps = connectorSetupSteps({
      provider: 'mcp',
      authorizationStrategy: 'project',
      connected: false,
      requestAuthType: 'bearer',
    });

    expect(steps[0]?.description).toContain('MCP endpoint');
    expect(steps[1]?.description).toContain('Bearer credential');
    expect(steps[2]?.description).toContain('Connected');
  });

  test('describes the operational checks after connection', () => {
    const steps = connectorSetupSteps({
      provider: 'openapi',
      authorizationStrategy: 'user',
      connected: true,
      requestAuthType: 'api_key',
    });

    expect(steps.map((step) => step.title)).toEqual([
      'Review the active account',
      'Review tool access',
      'Use the connector',
    ]);
    expect(steps[0]?.description).toContain('private sessions');
  });
});

describe('connectorTechnicalRows', () => {
  test('returns exact protocol and request metadata', () => {
    expect(
      connectorTechnicalRows({
        transport: 'sse',
        endpoint: 'https://mcp.example.com/sse',
        url: null,
        baseUrl: null,
        auth: { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer' },
        authorizationStrategy: 'project',
        headers: { Accept: 'application/json', 'X-Client': 'kortix' },
      }),
    ).toEqual([
      { label: 'Transport', value: 'SSE' },
      { label: 'Endpoint', value: 'https://mcp.example.com/sse' },
      { label: 'Authentication', value: 'Bearer token' },
      { label: 'Credential location', value: 'Request header · Authorization' },
      { label: 'Access', value: 'Project · one shared connection' },
      { label: 'Request headers', value: 'Accept, X-Client' },
    ]);
  });

  test('omits absent protocol values and states no authentication', () => {
    expect(
      connectorTechnicalRows({
        transport: null,
        endpoint: null,
        url: null,
        baseUrl: null,
        auth: { type: 'none', in: 'header', name: null, prefix: null },
        authorizationStrategy: 'user',
        headers: {},
      }),
    ).toEqual([
      { label: 'Authentication', value: 'None' },
      { label: 'Access', value: 'Each member · separate connection' },
    ]);
  });
});
