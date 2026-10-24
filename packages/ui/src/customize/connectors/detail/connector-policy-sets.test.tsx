import type { ConnectorPolicySet } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../../primitives/tooltip';

import { connectorPolicySetsKey } from '../tools/policy-sets';
import { ConnectorPolicySetBar } from './connector-policy-sets';

const SETS: ConnectorPolicySet[] = [
  { name: 'read_only', description: 'Read and search, never send', policies: [], agents: ['support'] },
  { name: 'outreach', description: null, policies: [], agents: [] },
];

function render(value: string | null) {
  const client = new QueryClient();
  client.setQueryData(connectorPolicySetsKey('p1', 'gmail'), { sets: SETS });
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
  test('the base view explains the base rules and offers no set actions', () => {
    const markup = render(null);
    expect(markup).toContain('Callers without a rule set follow these rules.');
    expect(markup).not.toContain('aria-label="Delete rule set"');
  });

  test('a set in use names its agents and refuses delete', () => {
    const markup = render('read_only');
    expect(markup).toContain('Read and search, never send · Used by support');
    expect(markup).toMatch(/aria-label="Delete rule set"[^>]*disabled=""|disabled=""[^>]*aria-label="Delete rule set"/);
  });

  test('an unused set can be deleted and says how to assign it', () => {
    const markup = render('outreach');
    expect(markup).toContain("No agent uses this rule set yet.");
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
