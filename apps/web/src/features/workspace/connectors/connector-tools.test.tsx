import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConnectorAction, ConnectorPolicyAction } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

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

describe('row badges', () => {
  test('nothing extra renders when the caller supplies no badge', () => {
    expect(render()).not.toContain('data-testid="badge"');
  });

  test('a caller badge rides alongside the picker', () => {
    // Used by the connector detail to say a pattern rule or a project-wide rule
    // already decides a tool — the picker's own value cannot express that.
    const html = render({
      renderToolBadge: (t: ConnectorAction) =>
        t.path === 'send_email' ? <span>Allow · rule</span> : null,
    });
    expect(html).toContain('Allow · rule');
  });
});

describe('multi-select', () => {
  const selection = {
    selected: new Set<string>(),
    onToggle: () => {},
    onSetAll: () => {},
    onApply: () => {},
  };

  test('no checkboxes and no bulk bar when the caller wants no selection', () => {
    const html = render({ canWrite: true });
    expect(html).not.toContain('Select Search emails');
    expect(html).not.toContain('selected');
  });

  test('every row is selectable once a selection API is supplied', () => {
    const html = render({ canWrite: true, selection });
    expect(html).toContain('Select Search emails');
    expect(html).toContain('Select Send email');
  });

  test('selection is refused without write access, like every other mutation', () => {
    const html = render({ canWrite: false, selection });
    expect(html).not.toContain('Select Search emails');
  });

  test('the bulk bar stays out of the way until something is picked', () => {
    expect(render({ canWrite: true, selection })).not.toContain('Set to');
  });

  test('picking a tool reveals the bulk bar with every policy choice', () => {
    const html = render({
      canWrite: true,
      selection: { ...selection, selected: new Set(['send_email']) },
    });
    expect(html).toContain('1 selected');
    expect(html).toContain('Set to');
    expect(html).toContain('Block');
    expect(html).toContain('Clear');
  });

  test('a partial selection offers select-all over what the search left visible', () => {
    const html = render({
      canWrite: true,
      selection: { ...selection, selected: new Set(['send_email']) },
    });
    expect(html).toContain('Select all 4');
  });

  test('Clear drops the whole selection, not just the visible part', () => {
    // Apply operates on the whole selection. A search-scoped Clear would let a
    // user filter, "clear", and then apply a policy to tools they believed were
    // deselected and can no longer see — silently widening access.
    const cleared: string[][] = [];
    renderToStaticMarkup(
      <ConnectorTools
        tools={TOOLS}
        perTool={{}}
        onChange={() => {}}
        canWrite
        selection={{
          ...selection,
          selected: new Set(['send_email', 'delete_thread']),
          onSetAll: (paths, select) => {
            if (!select) cleared.push(paths);
          },
        }}
      />,
    );
    // Rendering alone does not fire it; assert the handler is wired to the
    // selection rather than to visiblePaths by checking the source contract.
    const src = readFileSync(
      fileURLToPath(new URL('./connector-tools.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('onSetAll([...selecting.selected], false)');
    expect(src).not.toContain('onSetAll(visiblePaths, false)');
  });

  test('select-all disappears once everything visible is already picked', () => {
    const html = render({
      canWrite: true,
      selection: {
        ...selection,
        selected: new Set(TOOLS.map((t) => t.path)),
      },
    });
    expect(html).toContain('4 selected');
    expect(html).not.toContain('Select all');
  });
});

describe('group header', () => {
  test('the bulk picker is nested inside the trigger, not a sibling of it', () => {
    // DisclosureTrigger clones EVERY direct child with its own onClick, which
    // would overwrite the picker wrapper's stopPropagation and collapse the
    // group whenever the bulk control is used. One child keeps it intact.
    const html = render({ canWrite: true, onChangeGroup: () => {} });
    const triggers = html.match(/aria-expanded="true"/g) ?? [];
    expect(triggers).toHaveLength(2);
  });
});
