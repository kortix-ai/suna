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
  test('lists the agents it runs, never itself, and links each one', () => {
    const markup = render(true);
    expect(markup).toContain('>Agents <span');
    expect(markup).toContain(`/projects/${PROJECT}/customize/agents/kortix`);
    expect(markup).toContain(`/projects/${PROJECT}/customize/agents/researcher`);
    expect(markup).not.toContain(`/customize/agents/meta`);
    expect(markup).toContain('Researcher');
  });

  test('states what it can never do and the project switch', () => {
    const markup = render(true);
    for (const line of ['Access', 'New tokens', 'Project secrets', 'Direct connector calls', 'Project setting']) {
      expect(markup).toContain(line);
    }
    expect(markup).toContain('<span class="font-mono">builtin_agents.my_kortix: false</span>');
  });

  test('capability state follows the viewer and the project', () => {
    canWrite = false;
    const readOnly = render(false);
    expect(readOnly).toContain('Not allowed');
    expect(readOnly).not.toContain('>Allowed<');
    // Each refused capability names its grant once, in mono.
    for (const grant of ['project.agent.write', 'project.session.start', 'project.gitops.merge']) {
      expect(readOnly).toContain(`<span class="font-mono">${grant}</span>`);
    }
    expect(readOnly).toContain('Anyone who manages this project can grant it.');
    expect(readOnly).toContain('Goals off');
    canWrite = true;
    const manager = render(true);
    expect(manager).toContain('>Allowed<');
    expect(manager).not.toContain('Not allowed');
    expect(manager).not.toContain('Goals off');
    expect(manager).toContain('goal coordinator session');
  });
});
