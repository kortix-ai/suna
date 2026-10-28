import { qk } from '@kortix/sdk/react';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let canWrite = false;
mock.module('../../internal/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWrite }),
}));

const { PlatformAgentOverview } = await import('./platform-agent-overview');

const PROJECT = 'synthetic-project';
const config = {
  default_agent: 'meta',
  builtin_agents: { my_kortix: true },
  agents: [
    { name: 'meta', path: '/workspace/AGENTS.md', platform: true, mode: 'primary', description: 'The one agent you talk to.' },
    { name: 'kortix', path: 'kortix.yaml#agents.kortix', mode: 'primary', description: 'The project agent.' },
    { name: 'researcher', path: 'kortix.yaml#agents.researcher', mode: 'primary', description: null },
  ],
} as unknown as ProjectConfigSummary;

function render(goals: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qk.project.detail(PROJECT), { project: { experimental: { goals } }, config });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PlatformAgentOverview projectId={PROJECT} config={config} />
    </QueryClientProvider>,
  );
}

describe('PlatformAgentOverview (My Kortix)', () => {
  test('says what it does and how, in a few lines, with the project switch', () => {
    const markup = render(true);
    expect(markup).toContain('It routes each task to the agent made for it');
    for (const line of ['durable cloud session', 'never holds more than you do', 'change request you approve']) expect(markup).toContain(line);
    expect(markup).toContain('<span class="font-mono">builtin_agents.my_kortix: false</span>');
  });

  test('lists no agents, capabilities or access table', () => {
    const markup = render(true);
    expect(markup).not.toContain('/customize/agents/');
    for (const gone of ['Capabilities', 'Run goals', 'Build spaces', 'New tokens']) expect(markup).not.toContain(gone);
  });

  test('the composer shows only to a viewer who may start a session', () => {
    canWrite = false;
    expect(render(false)).not.toContain('<textarea');
    canWrite = true;
    expect(render(false)).toContain('<textarea');
  });
});
