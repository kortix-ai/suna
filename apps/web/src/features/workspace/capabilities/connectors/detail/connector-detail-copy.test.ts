import { describe, expect, test } from 'bun:test';

import {
  connectorConnectionIsReady,
  connectorSetupSteps,
  recommendedSurfaceVariant,
  surfacesRecommendedFirst,
} from './connector-detail-copy';

describe('connectorConnectionIsReady', () => {
  const connector = {
    provider: 'mcp' as const,
    status: 'active' as const,
    authorizationStrategy: 'project' as const,
    authSecret: 'TOKEN',
    secretSet: false,
  };

  test('treats active connectors with no authentication as ready', () => {
    expect(connectorConnectionIsReady({ ...connector, authSecret: null }, false)).toBe(true);
  });

  test('requires the strategy-compatible connection for user authorization', () => {
    const userConnector = { ...connector, authorizationStrategy: 'user' as const };
    expect(connectorConnectionIsReady(userConnector, false)).toBe(false);
    expect(connectorConnectionIsReady(userConnector, true)).toBe(true);
  });

  test('never reports disabled, errored, or unfinished OAuth connectors as ready', () => {
    expect(connectorConnectionIsReady({ ...connector, status: 'disabled' }, true)).toBe(false);
    expect(connectorConnectionIsReady({ ...connector, status: 'error' }, true)).toBe(false);
    expect(connectorConnectionIsReady({ ...connector, status: 'needs_auth' }, true)).toBe(false);
  });
});

describe('connectorSetupSteps', () => {
  test('a managed project connector names the Connect button and the Accounts tab', () => {
    expect(
      connectorSetupSteps({
        provider: 'composio',
        authorizationStrategy: 'project',
        connected: false,
        requestAuthType: 'oauth2',
      }),
    ).toEqual([
      {
        title: 'Click Connect',
        description: 'The Connect button above opens the provider’s own sign-in window.',
      },
      {
        title: 'Approve OAuth access',
        description: 'Sign in to the provider and approve the requested account or workspace.',
      },
      {
        title: 'Check the account under Accounts',
        description:
          'You land back on this page. The account appears in the Accounts tab below, and the shared project account reports Connected.',
      },
    ]);
  });

  test('a user-strategy managed connector names the button that actually exists', () => {
    const steps = connectorSetupSteps({
      provider: 'pipedream',
      authorizationStrategy: 'user',
      connected: false,
      requestAuthType: 'oauth2',
    });
    expect(steps[0]?.title).toBe('Click Add my own');
    expect(steps[2]?.description).toContain('your account for private sessions');
  });

  test('a direct connector says where the credential comes from', () => {
    const steps = connectorSetupSteps({
      provider: 'openapi',
      authorizationStrategy: 'project',
      connected: false,
      requestAuthType: 'api_key',
    });
    // Titles name the button as labelled on the page — the primary CTA says
    // Connect for every provider kind now, never "Add credential".
    expect(steps[1]?.title).toBe('Click Connect');
    expect(steps[1]?.description).toContain('developer or API settings');
    expect(steps[1]?.description).toContain('agents never see it');
  });

  test('the MCP script leads with one-click OAuth, not with pasting a key', () => {
    const steps = connectorSetupSteps({
      provider: 'mcp',
      authorizationStrategy: 'project',
      connected: false,
      requestAuthType: 'bearer',
    });
    expect(steps[1]?.title).toBe('Click Connect');
    expect(steps[1]?.description).toContain('one click');
  });

  test('describes direct MCP credential setup', () => {
    const steps = connectorSetupSteps({
      provider: 'mcp',
      authorizationStrategy: 'project',
      connected: false,
      requestAuthType: 'bearer',
    });

    expect(steps[0]?.description).toContain('MCP endpoint');
    expect(steps[1]?.description).toContain('paste the token');
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

describe('recommendedSurfaceVariant — MCP-first surface pick (COR-17)', () => {
  const mcp = { kind: 'mcp', connector: { provider: 'mcp' } };
  const openapi = { kind: 'openapi', connector: { provider: 'openapi' } };
  const docsOnly = { kind: 'graphql', connector: null };

  test('an addable MCP surface wins regardless of feed position', () => {
    expect(recommendedSurfaceVariant([openapi, docsOnly, mcp])).toBe(mcp);
  });

  test('an MCP surface without a template cannot win over an addable one', () => {
    const mcpDocsOnly = { kind: 'mcp', connector: null };
    expect(recommendedSurfaceVariant([mcpDocsOnly, openapi])).toBe(openapi);
  });

  test('falls back to the first addable surface, then the first surface', () => {
    expect(recommendedSurfaceVariant([docsOnly, openapi])).toBe(openapi);
    expect(recommendedSurfaceVariant([docsOnly])).toBe(docsOnly);
    expect(recommendedSurfaceVariant([])).toBe(null);
  });

  test('surfacesRecommendedFirst moves the pick to the front and keeps the rest stable', () => {
    expect(surfacesRecommendedFirst([openapi, docsOnly, mcp])).toEqual([mcp, openapi, docsOnly]);
    expect(surfacesRecommendedFirst([])).toEqual([]);
  });
});
