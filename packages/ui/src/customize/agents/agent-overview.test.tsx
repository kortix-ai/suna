import { qk } from '@kortix/sdk/react';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';

// The instructions preview parses markdown with DOMParser.
Object.defineProperty(globalThis, 'DOMParser', { value: new Window().DOMParser, configurable: true });

mock.module('../../internal/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: false }),
  useProjectPageCans: () => ({}),
}));

const { AgentOverview } = await import('./agent-overview');

const PROJECT = 'synthetic-project';
const meta = {
  name: 'meta',
  path: 'builtin#agents.meta',
  mode: 'primary',
  description: 'The one agent you talk to.',
  source: 'kortix.yaml',
  enabled: true,
  sandbox: 'meta',
  platform: true,
  builtin: 'my_kortix',
  scope: { env: [], connectors: [], kortix_permissions: 'all', kortix_cli: 'all', apps: [] },
} as unknown as ProjectConfigSummary['agents'][number];
const declared = { ...meta, name: 'kortix', path: 'agents/kortix.md', platform: undefined, builtin: undefined };
const config = { default_agent: 'meta', agents: [meta, declared] } as unknown as ProjectConfigSummary;

function render(agent: ProjectConfigSummary['agents'][number]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qk.project.detail(PROJECT), { account_id: 'synthetic-account', config });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AgentOverview
        agent={agent}
        config={config}
        block={{ connectors: 'none', secrets: 'none', kortix_permissions: 'all', behavior: { prompt: 'You are My Kortix.' } }}
        prompt="You are My Kortix."
        views={['skills', 'connectors', 'secrets', 'actions']}
        hrefFor={() => null}
        sourcePath="agents/kortix.md"
      />
    </QueryClientProvider>,
  );
}

describe('AgentOverview', () => {
  test('My Kortix says it is built in and how to turn it off, not where it is saved', () => {
    const markup = render(meta);
    expect(markup).toContain('Built in. Kortix maintains this agent; turn it off with');
    expect(markup).toContain('<span class="font-mono">builtin_agents.my_kortix: false</span>');
    expect(markup).not.toContain('agents.meta</span>');
    // Read-only: no editor, so no text field.
    expect(markup).not.toContain('<textarea');
    // The prompt renders after the markdown loads; SSR shows the Instructions section and its count.
    expect(markup).toContain('Instructions<span class="text-muted-foreground ml-2 font-normal tabular-nums">4 words</span>');
  });

  test('a declared agent keeps its saved-in line', () => {
    const markup = render(declared);
    expect(markup).toContain('agents.kortix</span>');
    expect(markup).not.toContain('Built in. Kortix maintains this agent');
  });
});
