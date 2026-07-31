import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SessionScopeControl,
  SessionScopeControlContent,
  setAllSessionSecrets,
  setSessionConnectorAuthorization,
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
  connector_profiles: {
    status: 'ready',
    items: [
      {
        slug: 'calendar',
        name: 'Calendar',
        authorization_strategy: 'user',
        authorizations: [
          {
            authorization_id: 'authorization-calendar',
            label: 'My calendar',
            is_default: true,
          },
        ],
      },
      {
        slug: 'crm',
        name: 'CRM',
        authorization_strategy: 'project',
        authorizations: [
          {
            authorization_id: 'authorization-crm',
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
        calendar: { authorization_id: 'authorization-calendar' },
        crm: { authorization_id: 'authorization-crm' },
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
          connector_profiles: { status: 'unavailable' },
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

  test('replaces one connector authorization without changing other bindings', () => {
    const draft: SessionScopeDraft = {
      connector_bindings: {
        calendar: { authorization_id: 'authorization-calendar' },
        crm: { authorization_id: 'authorization-crm' },
      },
    };

    expect(setSessionConnectorAuthorization(draft, 'calendar', 'authorization-calendar-2')).toEqual(
      {
        connector_bindings: {
          calendar: { authorization_id: 'authorization-calendar-2' },
          crm: { authorization_id: 'authorization-crm' },
        },
      },
    );
    expect(setSessionConnectorAuthorization(draft, 'calendar', null)).toEqual({
      connector_bindings: {
        crm: { authorization_id: 'authorization-crm' },
      },
    });
  });

  test('enables a connector with its default authorization and removes it when disabled', () => {
    const connector =
      catalog.connector_profiles.status === 'ready'
        ? catalog.connector_profiles.items[0]
        : undefined;

    expect(connector).toBeDefined();
    expect(setSessionConnectorEnabled({ connector_bindings: {} }, connector!, true)).toEqual({
      connector_bindings: {
        calendar: { authorization_id: 'authorization-calendar' },
      },
    });
    expect(
      setSessionConnectorEnabled(
        {
          connector_bindings: {
            calendar: { authorization_id: 'authorization-calendar' },
          },
        },
        connector!,
        false,
      ),
    ).toEqual({ connector_bindings: {} });
  });

  test('does not enable a connector without an available authorization', () => {
    const connector =
      catalog.connector_profiles.status === 'ready'
        ? {
            ...catalog.connector_profiles.items[0],
            authorizations: [],
          }
        : undefined;
    const draft: SessionScopeDraft = { connector_bindings: {} };

    expect(connector).toBeDefined();
    expect(setSessionConnectorEnabled(draft, connector!, true)).toBe(draft);
  });
});
