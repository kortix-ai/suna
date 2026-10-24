import type { ConnectorPolicySet } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../../primitives/tooltip';

import { connectorPoliciesKey, connectorPolicySetsKey } from '../tools/policy-sets';
import { ConnectorPolicySetBar } from './connector-policy-sets';

const SETS: ConnectorPolicySet[] = [
  {
    name: 'read_only',
    description: 'Read and search, never send',
    policies: [
      { match: 'send_email', action: 'block' },
      { match: 'draft_*', action: 'block' },
    ],
    agents: ['support'],
  },
  { name: 'outreach', description: null, policies: [], agents: [] },
];

function render(value: string | null) {
  const client = new QueryClient();
  client.setQueryData(connectorPolicySetsKey('p1', 'gmail'), { sets: SETS });
  client.setQueryData(connectorPoliciesKey('p1', 'gmail', null), {
    policies: [{ match: 'list_labels', action: 'always_run' }],
    effective: [],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ConnectorPolicySetBar
          projectId="p1"
          slug="gmail"
          canWrite
          value={value}
          onChange={() => {}}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('ConnectorPolicySetBar', () => {
  test('every list is a tab, with the count of its rules, then New rule set', () => {
    const markup = render(null);
    expect(markup).toContain('role="tablist"');
    const tabs = [...markup.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '|'));
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toContain('Base rules');
    expect(markup).toContain('aria-label="1 rule"');
    expect(markup).toContain('aria-label="2 rules"');
    // `outreach` has no rules: no count.
    expect(markup.match(/aria-label="\d+ rules?"/g)).toHaveLength(2);
    expect(markup).toContain('New rule set');
  });

  test('the base view says who it applies to and offers no set actions', () => {
    const markup = render(null);
    expect(markup).toContain('Applies to every agent without a rule set.');
    expect(markup).not.toContain('aria-label="Delete rule set"');
  });

  test("a set in use links each agent to its Connectors page and refuses delete", () => {
    const markup = render('read_only');
    expect(markup).toContain('Read and search, never send · Used by');
    expect(markup).toContain('href="/projects/p1/customize/agents/support?section=connectors"');
    expect(markup).toMatch(/aria-label="Delete rule set"[^>]*disabled=""|disabled=""[^>]*aria-label="Delete rule set"/);
  });

  test('an unused set can be deleted and says how to assign it', () => {
    const markup = render('outreach');
    expect(markup).toContain('No agent uses it yet.');
    expect(markup).toContain("Give it to an agent on the agent&#x27;s Connectors page");
    expect(markup).not.toMatch(/disabled=""[^>]*aria-label="Delete rule set"|aria-label="Delete rule set"[^>]*disabled=""/);
  });

  test('a viewer without connector write sees nothing', () => {
    const client = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConnectorPolicySetBar projectId="p1" slug="gmail" canWrite={false} value={null} onChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(markup).toBe('');
  });
});
