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

describe('AgentsPage CLI identifiers', () => {
  test('shows exact ids beneath display names for primary agents and subagents', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.project.detail('synthetic-project'), {
      account_id: 'synthetic-account',
      config: {
        default_agent: 'release-helper',
        agents: [
          { name: 'release-helper', path: 'agents/release-helper.md', mode: 'primary' },
          { name: 'syntax-checker', path: 'agents/syntax-checker.md', mode: 'subagent' },
        ],
      },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentsPage projectId="synthetic-project" />
      </QueryClientProvider>,
    );
    for (const [name, id] of [
      ['Release-Helper', 'release-helper'],
      ['Syntax-Checker', 'syntax-checker'],
    ]) {
      expect(markup).toContain(name);
      expect(markup).toContain(`>${id}</code>`);
    }
  });
});
