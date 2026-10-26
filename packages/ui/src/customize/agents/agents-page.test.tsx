import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('../../internal/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: false }),
}));
mock.module('../use-configure-thread', () => ({
  useConfigureThread: () => ({ pending: false }),
  newConfigPrompt: () => '',
}));

const { AgentsPage } = await import('./agents-page');

// KRTX-3025: the card shows what the configuration grants, not the agent's prose.
describe('AgentsPage access line', () => {
  test('"Full access" or the connector count; nothing an agent lacks', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.project.detail('synthetic-project'), {
      account_id: 'synthetic-account',
      config: {
        default_agent: 'kortix',
        agents: [
          {
            name: 'kortix',
            path: 'agents/kortix.md',
            mode: 'primary',
            description: 'General knowledge worker.',
            scope: { env: 'all', connectors: 'all', kortix_permissions: 'all', kortix_cli: 'all' },
          },
          {
            name: 'store-builder',
            path: 'agents/store-builder.md',
            mode: 'primary',
            scope: { env: [], connectors: ['notion', 'gmail'], kortix_permissions: 'all', kortix_cli: 'all' },
          },
          {
            name: 'reflector',
            path: 'agents/reflector.md',
            mode: 'primary',
            scope: { env: [], connectors: [], kortix_permissions: 'all', kortix_cli: 'all' },
          },
        ],
      },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentsPage projectId="synthetic-project" />
      </QueryClientProvider>,
    );
    expect(markup).toContain('Full access');
    expect(markup).toContain('2 connectors');
    for (const absent of ['No connectors', 'No secrets', 'All Kortix actions', 'trigger', 'Default model']) {
      expect(markup).not.toContain(absent);
    }
  });
});
