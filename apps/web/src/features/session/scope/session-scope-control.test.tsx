import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SessionScopeControl,
  SessionScopeControlContent,
  setAllSessionSecrets,
  setSessionConnectorAuthorization,
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

  test('renders the active secret allowlist and one authorization selector per connector profile', () => {
    const html = renderControl({
      secrets: ['CALENDAR_TOKEN'],
      connector_bindings: {
        calendar: { authorization_id: 'authorization-calendar' },
        crm: { authorization_id: 'authorization-crm' },
      },
    });

    expect(html).toContain('1 selected');
    expect(html).toContain('Calendar token');
    expect(html).toContain('CRM token');
    expect(html).toContain('aria-label="Authorization for Calendar"');
    expect(html).toContain('aria-label="Authorization for CRM"');
    expect(html).toContain('Private');
    expect(html).toContain('Project');
    expect(html).toContain('Saved changes apply to the next prompt or tool call.');
  });

  test('distinguishes unrestricted secret access from an explicit empty allowlist', () => {
    const allHtml = renderControl({ secrets: null, connector_bindings: {} });
    const noneHtml = renderControl({ secrets: [], connector_bindings: {} });

    expect(allHtml).toContain('All allowed');
    expect(allHtml.match(/aria-checked="true"/g)).toHaveLength(3);
    expect(noneHtml).toContain('None allowed');
    expect(noneHtml).not.toContain('aria-checked="true"');
  });

  test('distinguishes an omitted secret axis from an explicit empty allowlist', () => {
    const unchangedHtml = renderControl({ connector_bindings: {} });
    const noneHtml = renderControl({ secrets: [], connector_bindings: {} });

    expect(unchangedHtml).toContain('Unchanged');
    expect(noneHtml).toContain('None allowed');
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

    expect(html).toContain('Secret access is unavailable');
    expect(html).toContain('Connector access is unavailable');
    expect(html).not.toContain('None allowed');
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
});
