import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectorAction, ConnectorPolicyAction } from '@kortix/sdk';

import { ConnectorTools } from './connector-tools';

function action(path: string, risk: string, description = ''): ConnectorAction {
  return { path, risk, description } as unknown as ConnectorAction;
}

const TOOLS = [
  action('search_emails', 'read', 'Search and read emails in Gmail.'),
  action('search_calendar_events', 'read', 'Search Google Calendar events.'),
  action('send_email', 'write', 'Send or forward an email.'),
  action('delete_thread', 'destructive', 'Delete an email thread.'),
];

function render(extra: Record<string, unknown> = {}, tools: ConnectorAction[] = TOOLS) {
  return renderToStaticMarkup(
    <ConnectorTools tools={tools} perTool={{}} onChange={() => {}} {...extra} />,
  );
}

describe('grouping', () => {
  test('renders both risk groups with their counts', () => {
    const html = render();
    expect(html).toContain('Read-only tools');
    expect(html).toContain('Write / delete tools');
  });

  test('shows a human label rather than the raw path', () => {
    const html = render();
    expect(html).toContain('Search emails');
    expect(html).toContain('Send email');
  });

  test('keeps the raw path reachable as the row title', () => {
    expect(render()).toContain('title="search_emails"');
  });

  test('renders each tool description', () => {
    const html = render();
    expect(html).toContain('Search and read emails in Gmail.');
    expect(html).toContain('Delete an email thread.');
  });

  test('omits a group that has no tools', () => {
    const html = render({}, [action('only_read', 'read')]);
    expect(html).toContain('Read-only tools');
    expect(html).not.toContain('Write / delete tools');
  });
});

describe('permissions', () => {
  test('a tool with no explicit policy reads as Default', () => {
    expect(render({ canWrite: true })).toContain('Default');
  });

  test('an explicit policy is shown on the row', () => {
    const perTool: Record<string, ConnectorPolicyAction> = { send_email: 'block' };
    expect(render({ perTool, canWrite: true })).toContain('Block');
  });

  test('without write access the picker is not a button', () => {
    const readOnly = render({ canWrite: false });
    expect(readOnly).not.toContain('Permission for Search emails');
  });

  test('with write access each row exposes a labelled picker', () => {
    expect(render({ canWrite: true })).toContain('Permission for Search emails');
  });

  test('the bulk group control appears only with write access and a handler', () => {
    expect(render({ canWrite: true })).not.toContain('Set permission for all');
    const html = render({ canWrite: true, onChangeGroup: () => {} });
    expect(html).toContain('Set permission for all read-only tools');
  });

  test('a rule-governed tool stays editable but is dimmed', () => {
    // A project-wide rule wins today, but it can be lifted later, so staging a
    // connector rule must remain possible. Dimming says "not in force"; it must
    // not become read-only.
    const html = render({
      canWrite: true,
      governedPaths: new Set(['send_email']),
    });
    expect(html).toContain('Permission for Send email');
    expect(html).toContain('opacity-40');
  });
});

describe('tool detail', () => {
  test('rows are not expanders when no detail renderer is supplied', () => {
    // Group headers legitimately carry aria-expanded="true"; a collapsed row
    // expander is the only thing that renders aria-expanded="false".
    expect(render()).not.toContain('aria-expanded="false"');
  });

  test('each row becomes an expander when a detail renderer is supplied', () => {
    const html = render({ renderToolDetail: () => <code>signature</code> });
    expect(html).toContain('aria-expanded="false"');
  });

  test('detail content stays collapsed until asked for', () => {
    const html = render({ renderToolDetail: () => <code>the-signature</code> });
    expect(html).not.toContain('the-signature');
  });
});

describe('empty states', () => {
  test('a connector with no tools says so instead of rendering empty groups', () => {
    const html = render({}, []);
    expect(html).toContain('exposes no tools yet');
    expect(html).not.toContain('Read-only tools');
  });

  test('search is hidden when there is nothing to search', () => {
    expect(render({}, [])).not.toContain('Search tools');
  });

  test('search is offered when the connector has tools', () => {
    expect(render()).toContain('Search tools');
  });
});
