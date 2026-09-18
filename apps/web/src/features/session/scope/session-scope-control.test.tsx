import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SessionSecretsEditor,
  setAllSessionSecrets,
  setSessionConnectorConnection,
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

const messages = {
  sessionScope: {
    resetDefault: 'Reset to default',
    secrets: {
      unavailableTitle: 'Secret access is unavailable',
      unavailableDescription: 'The current secret selection stays unchanged.',
      useProjectDefault: 'Use the project default',
      empty: 'No secrets are available for this agent.',
    },
  },
};

function withTranslations(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
      {children}
    </NextIntlClientProvider>
  );
}

function renderSecrets(draft: SessionScopeDraft, scopeCatalog = catalog) {
  return renderToStaticMarkup(
    withTranslations(
      <SessionSecretsEditor draft={draft} catalog={scopeCatalog} onChange={() => {}} />,
    ),
  );
}

// The connector checklist (`SessionConnectorsEditor`, `setSessionConnectorEnabled`)
// is gone — the session overrides panel has no Connectors axis any more (see
// `session-overrides-toolbar.tsx`). Credentials are not a session-minting
// decision: the agent may use every account it is entitled to and names one at
// call time (`kortix connectors call --account`). `setSessionConnectorConnection`
// stays below — `connector_bindings` is still a real, programmatic-API concept
// (Kortix as a Backend).
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

  test('reports catalog failures instead of rendering an empty selection', () => {
    expect(renderSecrets({}, unavailable)).toContain('Secret access is unavailable');
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
    expect(setSessionConnectorConnection(draft, 'calendar', null)).toEqual({
      connector_bindings: {},
      connector_bindings_inherited: false,
    });
  });
});
