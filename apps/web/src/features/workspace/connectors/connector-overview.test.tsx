import { describe, expect, test } from 'bun:test';
import type { ConnectorAction } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';
import {
  ConnectorOverview,
  connectorCapabilitySummary,
  connectorHeadline,
} from './connector-overview';

function action(path: string, risk: string): ConnectorAction {
  return { path, risk, description: '' } as unknown as ConnectorAction;
}

const TOOLS = [
  action('search_emails', 'read'),
  action('search_calendar_events', 'read'),
  action('send_email', 'write'),
  action('delete_thread', 'destructive'),
];

function render(extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ConnectorOverview slug="gmail" providerLabel="App" tools={TOOLS} {...extra} />
    </TooltipProvider>,
  );
}

describe('connectorHeadline', () => {
  test('names the provider and how much the connector can do', () => {
    expect(connectorHeadline('App', 12)).toBe(
      'App connector — 12 tools agents in this project can call.',
    );
  });

  test('singularises a one-tool connector', () => {
    expect(connectorHeadline('MCP', 1)).toContain('1 tool agents');
  });

  test('says nothing was discovered rather than claiming zero tools is normal', () => {
    expect(connectorHeadline('MCP', 0)).toBe('MCP connector — no tools discovered yet.');
  });
});

describe('connectorCapabilitySummary', () => {
  test('states the read/write split the permission list is organised by', () => {
    expect(connectorCapabilitySummary(TOOLS)).toBe('2 read-only tools and 2 write / delete tools');
  });

  test('drops a bucket that has nothing in it', () => {
    expect(connectorCapabilitySummary([action('a', 'read')])).toBe('1 read-only tool');
  });

  test('an unknown risk counts as write, never as read-only', () => {
    // Mislabelling a dangerous tool as read-only in the very panel where it is
    // granted is the failure this guards.
    expect(connectorCapabilitySummary([action('a', 'quantum')])).toBe('1 write / delete tool');
  });

  test('no tools points at sync instead of rendering an empty split', () => {
    expect(connectorCapabilitySummary([])).toContain('sync this connector');
  });
});

describe('ConnectorOverview', () => {
  test('leads with what the connector does', () => {
    const html = render();
    expect(html).toContain('What it does');
    expect(html).toContain('2 read-only tools and 2 write / delete tools');
  });

  test('carries the slug, which is what the rules editor matches on', () => {
    expect(render()).toContain('gmail');
  });

  test('says so plainly when nothing is connected', () => {
    expect(render()).toContain('Not connected');
  });

  test('names the connection when there is one', () => {
    const html = render({ connectedAs: 'support@acme.com' });
    expect(html).toContain('support@acme.com');
    expect(html).not.toContain('Not connected');
  });

  test('shows the connection id — the value connector_bindings takes', () => {
    const html = render({ profileId: 'prof_123', onCopyProfileId: () => {} });
    expect(html).toContain('prof_123');
    expect(html).toContain('Copy connection ID');
  });

  test('omits the connection id row entirely when there is no connection', () => {
    expect(render()).not.toContain('Connection ID');
  });

  test('renders the caller-owned status badge rather than deriving its own', () => {
    const html = render({ status: <span>Needs setup</span> });
    expect(html).toContain('Status');
    expect(html).toContain('Needs setup');
  });
});
