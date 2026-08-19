import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SessionConnectorsEditor,
  SessionSecretsEditor,
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
        authorization_strategy: 'project',
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

const unavailable: SessionScopeSelectionCatalog = {
  secrets: { status: 'unavailable' },
  connector_connections: { status: 'unavailable' },
};

function renderSecrets(draft: SessionScopeDraft, scopeCatalog = catalog) {
  return renderToStaticMarkup(
    <SessionSecretsEditor draft={draft} catalog={scopeCatalog} onChange={() => {}} />,
  );
}

function renderConnectors(draft: SessionScopeDraft, scopeCatalog = catalog) {
  return renderToStaticMarkup(
    <SessionConnectorsEditor draft={draft} catalog={scopeCatalog} onChange={() => {}} />,
  );
}

describe('session scope editors', () => {
  test('an inherited secrets axis keeps the project default checked', () => {
    // `null` is the INHERITED state, so the box that says "use the project
    // default" is the one that is on. Unchecking a secret is what converts the
    // axis into an explicit allowlist — an override is never created by
    // opening the panel.
    const html = renderSecrets({ secrets: null });

    expect(html).toContain('Use the project default');
    expect(html).toContain('Calendar token');
    expect(html).not.toContain('Reset to project default');
  });

  test('shows the connection picker only for a selected connector', () => {
    const html = renderConnectors({
      connector_bindings: { calendar: { connection_id: 'connection-calendar' } },
      connector_bindings_inherited: false,
    });

    expect(html).toContain('aria-label="Connection for Calendar"');
    expect(html).not.toContain('aria-label="Connection for CRM"');
  });

  test('names a connector that has nothing connected as a requirement', () => {
    // A binding carries a connection id, so it cannot express "this session
    // needs Calendar and nothing is connected". The requirement can, and the
    // next turn stops at a connect prompt instead of failing mid-answer.
    const disconnected: SessionScopeSelectionCatalog = {
      ...catalog,
      connector_connections: {
        status: 'ready',
        items: [
          { slug: 'calendar', name: 'Calendar', authorization_strategy: 'user', connections: [] },
        ],
      },
    };
    const html = renderConnectors(
      {
        connector_bindings: {},
        require_connectors: ['calendar'],
        connector_bindings_inherited: false,
      },
      disconnected,
    );

    expect(html).toContain('Required — connect to continue');
    expect(html).not.toContain('aria-label="Connection for Calendar"');
  });

  test('reports catalog failures instead of rendering an empty selection', () => {
    expect(renderSecrets({}, unavailable)).toContain('Secret access is unavailable');
    expect(renderConnectors({}, unavailable)).toContain('Connector access is unavailable');
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
