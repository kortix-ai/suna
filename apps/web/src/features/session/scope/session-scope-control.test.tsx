import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SessionScopeControl,
  SessionScopeControlContent,
  setAllSessionSecrets,
  setSessionConnectorConnection,
  setSessionConnectorEnabled,
  toggleSessionSecret,
} from './session-scope-control';
import type { SessionScopeDraft, SessionScopeSelectionCatalog } from './session-scope-model';

const catalog: SessionScopeSelectionCatalog = {
  secrets: {
    status: 'ready',
    items: [
      { identifier: 'CALENDAR_TOKEN', name: 'Calendar token' },
      { identifier: 'CRM_TOKEN', name: 'CRM token' },
    ],
  },
  connector_connections: {
    status: 'ready',
    items: [
      {
        slug: 'calendar',
        name: 'Calendar',
        authorization_strategy: 'user',
        connections: [
          {
            connection_id: 'connection-calendar',
            label: 'My calendar',
            is_default: true,
          },
        ],
      },
      {
        slug: 'crm',
        name: 'CRM',
        authorization_strategy: 'workspace',
        connections: [
          {
            connection_id: 'connection-crm',
            label: 'Project CRM',
            is_default: true,
          },
        ],
      },
    ],
  },
};

function renderControl(
  draft: SessionScopeDraft,
  props: Partial<React.ComponentProps<typeof SessionScopeControlContent>> = {},
) {
  return renderToStaticMarkup(
    <SessionScopeControlContent
      draft={draft}
      catalog={catalog}
      onChange={() => {}}
      onSave={() => {}}
      {...props}
    />,
  );
}

describe('SessionScopeControlContent', () => {
  test('uses a non-submit toolbar trigger inside the session composer', () => {
    const html = renderToStaticMarkup(
      <SessionScopeControl
        draft={{ secrets: [], connector_bindings: {} }}
        catalog={catalog}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Configure session scope"');
    expect(html).toContain('type="button"');
  });

  test('renders compact collapsed summaries for the selected scope', () => {
    const html = renderControl({
      secrets: ['CALENDAR_TOKEN'],
      connector_bindings: {
        calendar: { connection_id: 'connection-calendar' },
        crm: { connection_id: 'connection-crm' },
      },
    });

    expect(html).toContain('Session access');
    expect(html).toContain('Share only the secrets and connectors this session needs.');
    expect(html).toContain('1 selected');
    expect(html).toContain('2 selected');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="Authorization for Calendar"');
    expect(html).not.toContain('aria-label="Authorization for CRM"');
    expect(html).toContain('Changes apply to the next prompt.');
  });

  test('distinguishes unrestricted secret access from an explicit empty allowlist', () => {
    const allHtml = renderControl({ secrets: null, connector_bindings: {} });
    const noneHtml = renderControl({ secrets: [], connector_bindings: {} });

    expect(allHtml).toContain('All allowed');
    expect(noneHtml).toContain('None selected');
    expect(allHtml).not.toContain('aria-checked="true"');
    expect(noneHtml).not.toContain('aria-checked="true"');
  });

  test('distinguishes an omitted secret axis from an explicit empty allowlist', () => {
    const unchangedHtml = renderControl({ connector_bindings: {} });
    const noneHtml = renderControl({ secrets: [], connector_bindings: {} });

    expect(unchangedHtml).toContain('Unchanged');
    expect(noneHtml).toContain('None selected');
  });

  test('shows catalog failures without converting them into empty selections', () => {
    const html = renderToStaticMarkup(
      <SessionScopeControlContent
        draft={{}}
        catalog={{
          secrets: { status: 'unavailable' },
          connector_connections: { status: 'unavailable' },
        }}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );

    expect(html.match(/>Unavailable</g)).toHaveLength(2);
    expect(html).not.toContain('None selected');
  });

  test('shows saving state and the non-retroactive warning', () => {
    const html = renderControl(
      { secrets: [], connector_bindings: {} },
      { saving: true, retroactive: false },
    );

    expect(html).toContain(
      'Removed secret values can remain in the current conversation or existing shells.',
    );
    expect(html).toContain('animate-spinner-orbit');
    expect(html).toContain('disabled=""');
  });

  test('disables only the save action when the current draft is unsafe to commit', () => {
    const html = renderControl({ secrets: [], connector_bindings: {} }, { saveDisabled: true });

    expect(html).toContain('type="button" disabled="">Save');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
});

describe('session scope control changes', () => {
  test('changes unrestricted secret access into an explicit allowlist when one secret is removed', () => {
    expect(toggleSessionSecret({ secrets: null }, catalog, 'CRM_TOKEN', false)).toEqual({
      secrets: ['CALENDAR_TOKEN'],
    });
  });

  test('preserves null and empty-list semantics when all-secret access changes', () => {
    expect(setAllSessionSecrets({ secrets: [] }, true)).toEqual({ secrets: null });
    expect(setAllSessionSecrets({ secrets: null }, false)).toEqual({ secrets: [] });
  });

  test('replaces one connection without changing other bindings', () => {
    const draft: SessionScopeDraft = {
      connector_bindings: {
        calendar: { connection_id: 'connection-calendar' },
        crm: { connection_id: 'connection-crm' },
      },
    };

    expect(setSessionConnectorConnection(draft, 'calendar', 'connection-calendar-2')).toEqual({
      connector_bindings: {
        calendar: { connection_id: 'connection-calendar-2' },
        crm: { connection_id: 'connection-crm' },
      },
      connector_bindings_inherited: false,
    });
    expect(setSessionConnectorConnection(draft, 'calendar', null)).toEqual({
      connector_bindings: {
        crm: { connection_id: 'connection-crm' },
      },
      connector_bindings_inherited: false,
    });
  });

  test('changes inherited connector defaults into an explicit replacement', () => {
    const connector =
      catalog.connector_connections.status === 'ready'
        ? catalog.connector_connections.items[0]
        : undefined;
    expect(connector).toBeDefined();
    const draft: SessionScopeDraft = {
      connector_bindings: {
        calendar: { connection_id: 'connection-calendar' },
      },
      connector_bindings_inherited: true,
    };

    expect(setSessionConnectorConnection(draft, 'calendar', 'connection-calendar-2')).toEqual({
      connector_bindings: {
        calendar: { connection_id: 'connection-calendar-2' },
      },
      connector_bindings_inherited: false,
    });
    expect(setSessionConnectorEnabled(draft, connector!, false)).toEqual({
      connector_bindings: {},
      connector_bindings_inherited: false,
    });
  });

  test('enables a connector with its default authorization and removes it when disabled', () => {
    const connector =
      catalog.connector_connections.status === 'ready'
        ? catalog.connector_connections.items[0]
        : undefined;

    expect(connector).toBeDefined();
    expect(setSessionConnectorEnabled({ connector_bindings: {} }, connector!, true)).toEqual({
      connector_bindings: {
        calendar: { connection_id: 'connection-calendar' },
      },
      connector_bindings_inherited: false,
    });
    expect(
      setSessionConnectorEnabled(
        {
          connector_bindings: {
            calendar: { connection_id: 'connection-calendar' },
          },
        },
        connector!,
        false,
      ),
    ).toEqual({ connector_bindings: {}, connector_bindings_inherited: false });
  });

  test('a connector with NO authorization is selectable, as a requirement', () => {
    // This used to be un-selectable, which meant you could only require a
    // connector that already worked — backwards, since needing one you have not
    // connected yet is the case worth expressing. It cannot become a binding
    // (there is no connection id to bind), so it is recorded as a requirement
    // and the next turn stops at a connect prompt.
    const connector =
      catalog.connector_connections.status === 'ready'
        ? { ...catalog.connector_connections.items[0], connections: [] }
        : undefined;
    expect(connector).toBeDefined();
    const draft: SessionScopeDraft = { connector_bindings: {} };

    const next = setSessionConnectorEnabled(draft, connector!, true);

    expect(next.require_connectors).toEqual([connector!.slug]);
    expect(next.connector_bindings).toEqual({});
    expect(next.connector_bindings_inherited).toBeFalse();
  });

  test('unchecking it drops the requirement rather than leaving it behind', () => {
    const connector =
      catalog.connector_connections.status === 'ready'
        ? { ...catalog.connector_connections.items[0], connections: [] }
        : undefined;
    const draft: SessionScopeDraft = {
      connector_bindings: {},
      require_connectors: [connector!.slug],
    };

    expect(setSessionConnectorEnabled(draft, connector!, false).require_connectors).toEqual([]);
  });

  test('requiring the same connector twice does not duplicate it', () => {
    const connector =
      catalog.connector_connections.status === 'ready'
        ? { ...catalog.connector_connections.items[0], connections: [] }
        : undefined;
    const draft: SessionScopeDraft = {
      connector_bindings: {},
      require_connectors: [connector!.slug],
    };

    expect(setSessionConnectorEnabled(draft, connector!, true)).toBe(draft);
  });

  test('choosing an authorization converts the requirement into a binding', () => {
    // Both would mean the server holds the same requirement twice, and it would
    // outlive the binding if the binding were later removed.
    const connector =
      catalog.connector_connections.status === 'ready'
        ? catalog.connector_connections.items[0]
        : undefined;
    expect(connector?.connections.length).toBeGreaterThan(0);
    const draft: SessionScopeDraft = {
      connector_bindings: {},
      require_connectors: [connector!.slug],
    };

    const next = setSessionConnectorEnabled(draft, connector!, true);

    expect(next.require_connectors).toEqual([]);
    expect(next.connector_bindings?.[connector!.slug]).toBeDefined();
  });
});
