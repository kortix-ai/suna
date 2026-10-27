import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { configureKortix } from '../core/http/config';
import { openSessionBundle, resetSessionOpenBundles } from '../core/session/open-bundle';
import { seedModelDefaultsFromOpenBundle } from './prefetch-session-open';
import { resolveModelDefault, useModelDefaults } from './use-model-defaults';

describe('resolveModelDefault', () => {
  test('uses agent, project, account, then platform precedence', () => {
    const data = {
      accountDefault: 'openai/gpt-account',
      projectDefault: 'anthropic/claude-project',
      platformDefault: 'kortix/platform',
      agentDefaults: { coder: 'google/gemini-agent' },
      resolvedForCaller: 'anthropic/claude-project',
      freeTier: false,
    };

    expect(resolveModelDefault(data, 'coder')).toEqual({
      providerID: 'kortix',
      modelID: 'google/gemini-agent',
    });
    expect(resolveModelDefault(data, 'reviewer')).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-project',
    });
  });

  test('never resolves the platform default for a free-tier caller', () => {
    // The gateway refuses every managed model to free tier.
    expect(
      resolveModelDefault(
        {
          accountDefault: null,
          projectDefault: null,
          platformDefault: 'deepseek-v4.1-flash',
          agentDefaults: {},
          resolvedForCaller: null,
          freeTier: true,
        },
        undefined,
      ),
    ).toBeUndefined();
  });
});

// The session-open snapshot (`GET .../snapshot`) answers `/model-defaults` in
// its `models` leg. `useModelDefaults` reads it and issues no request of its
// own. The gateway is the only model path, so nothing waits on `/detail`.
describe('model defaults from the session-open snapshot', () => {
  const originalFetch = globalThis.fetch;
  let root: ReactTestRenderer | undefined;
  let client: QueryClient;
  const DEFAULTS = {
    platformDefault: 'kortix/platform',
    accountDefault: null,
    agentDefaults: { coder: 'google/gemini-agent' },
    projectDefault: 'anthropic/claude-project',
    resolvedForCaller: 'anthropic/claude-project',
    resolvedSource: 'project',
    freeTier: false,
  };
  const KEY = ['model-defaults', 'p1'];

  function snapshot(models: unknown) {
    return {
      observed_at: '2026-10-02T00:00:00Z',
      session: { session_id: 's1' },
      turn: { known: false, reason: 'test' },
      queue: { known: false, reason: 'test' },
      transcript: { known: true, requested: false },
      config: { known: true, base_ref: null, agent_name: null, llm_gateway_enabled: true },
      models,
      audit: { known: false, reason: 'test' },
    };
  }

  /** Serves the snapshot; every other path answers the defaults route. */
  function serve(models: unknown) {
    const requests: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      const path = String(url);
      requests.push(path);
      if (path.includes('/snapshot')) return Response.json(snapshot(models));
      return Response.json({ ...DEFAULTS, projectDefault: 'from/the-route' });
    }) as unknown as typeof fetch;
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    return { requests };
  }

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    resetSessionOpenBundles();
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    client.clear();
    globalThis.fetch = originalFetch;
    resetSessionOpenBundles();
  });

  test('the snapshot answers model defaults with no /model-defaults and no /detail request', async () => {
    const { requests } = serve({ known: true, ...DEFAULTS });
    let value!: ReturnType<typeof useModelDefaults>;
    function Probe() {
      value = useModelDefaults('p1');
      return null;
    }
    openSessionBundle('p1', 's1');
    seedModelDefaultsFromOpenBundle(client, 'p1', 's1');
    await act(async () => {
      root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    await settle();

    // `llmGatewayEnabled` is deprecated: the gateway serves every project.
    expect(value.llmGatewayEnabled).toBe(true);
    expect(value.data).toEqual(DEFAULTS as never);
    expect(value.resolveDefaultFor('coder')).toEqual({ providerID: 'kortix', modelID: 'google/gemini-agent' });
    expect(requests.filter((url) => url.includes('/model-defaults'))).toHaveLength(0);
    expect(requests.filter((url) => url.endsWith('/detail'))).toHaveLength(0);
  });

  test('a snapshot never replaces defaults a read already cached', async () => {
    serve({ known: true, ...DEFAULTS });
    client.setQueryData(KEY, { ...DEFAULTS, projectDefault: 'already/cached' });
    openSessionBundle('p1', 's1');
    seedModelDefaultsFromOpenBundle(client, 'p1', 's1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.getQueryData<{ projectDefault: string }>(KEY)?.projectDefault).toBe('already/cached');
  });

  test('an unknown models leg (a failed read) falls back to the route', async () => {
    const { requests } = serve({ known: false, reason: 'read_failed' });
    openSessionBundle('p1', 's1');
    seedModelDefaultsFromOpenBundle(client, 'p1', 's1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.getQueryData<{ projectDefault: string }>(KEY)?.projectDefault).toBe('from/the-route');
    expect(requests.filter((url) => url.includes('/model-defaults'))).toHaveLength(1);
  });

  test('no open snapshot: nothing is seeded and nothing is requested', async () => {
    const { requests } = serve({ known: true, ...DEFAULTS });
    seedModelDefaultsFromOpenBundle(client, 'p1', 's1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.getQueryData(KEY)).toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});
