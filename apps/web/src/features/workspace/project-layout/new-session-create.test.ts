import { describe, expect, it } from 'bun:test';

import { createNewSessionScopeInitialization } from '@/features/session/scope/session-scope-toolbar';

import { buildNewSessionCreateInput } from './new-session-create';

describe('buildNewSessionCreateInput', () => {
  it('binds the picked agent as agent_name so it matches the first prompt', () => {
    // The composer sends agent="veyris" on the first prompt, so the session MUST
    // be created bound to "veyris": `project_sessions.agent_name` is what the
    // grant re-mint and connector authz resolve against, and a stale name mints
    // the wrong agent's tokens for that first turn.
    expect(buildNewSessionCreateInput({ agent: 'veyris' })).toEqual({
      agent_name: 'veyris',
    });
  });

  it('carries the sandbox slug through alongside the agent', () => {
    expect(buildNewSessionCreateInput({ agent: 'builder', sandbox_slug: 'node22' })).toEqual({
      agent_name: 'builder',
      sandbox_slug: 'node22',
    });
  });

  it('forces the fixed meta sandbox when the meta agent is selected', () => {
    expect(buildNewSessionCreateInput({ agent: 'meta', sandbox_slug: 'node22' })).toEqual({
      agent_name: 'meta',
      sandbox_slug: 'meta',
    });
  });

  it('binds only the sandbox slug when no agent is picked', () => {
    expect(buildNewSessionCreateInput({ sandbox_slug: 'node22' })).toEqual({
      sandbox_slug: 'node22',
    });
  });

  it('returns undefined when there is nothing to override', () => {
    // No agent and the default sandbox → omit the create overrides entirely.
    expect(buildNewSessionCreateInput({})).toBeUndefined();
    expect(buildNewSessionCreateInput()).toBeUndefined();
  });

  it('ignores an empty-string agent (never binds agent_name="")', () => {
    // An empty agent must NOT become agent_name:"" — that would record a bogus
    // agent name and resolve the first turn's grant against nothing.
    expect(buildNewSessionCreateInput({ agent: '' })).toBeUndefined();
  });

  it('files the session under a subproject, and that alone needs overrides', () => {
    // A subproject start carries no agent and no sandbox of its own — the
    // builder must still return a body, or the create would drop the slug and
    // the session would be filed under nothing.
    expect(buildNewSessionCreateInput({ subproject: 'marketing' })).toEqual({
      subproject: 'marketing',
    });
  });

  it('carries the subproject alongside the agent and the sandbox', () => {
    expect(
      buildNewSessionCreateInput({
        agent: 'writer',
        sandbox_slug: 'node22',
        subproject: 'marketing',
      }),
    ).toEqual({
      subproject: 'marketing',
      agent_name: 'writer',
      sandbox_slug: 'node22',
    });
  });

  it('ignores an empty-string subproject (never binds subproject="")', () => {
    // `''` is a REAL filter on the sessions LIST ("rows with no subproject"),
    // so it must not leak into a create body and be read as a slug.
    expect(buildNewSessionCreateInput({ subproject: '' })).toBeUndefined();
  });

  it('binds the complete committed connector selection at creation', () => {
    expect(
      buildNewSessionCreateInput({
        agent: 'builder',
        scope: {
          draft: {
            secrets: ['MAIL_TOKEN'],
            connector_bindings: {
              mail: { connection_id: 'connection-mail-private' },
            },
          },
          availability: { secrets: true, connector_bindings: true },
        },
      }),
    ).toEqual({
      agent_name: 'builder',
      connector_bindings: {
        mail: { connection_id: 'connection-mail-private' },
      },
      inherit_unbound: false,
    });
  });

  it('leaves untouched connector defaults to server-side resolution', () => {
    const initialization = createNewSessionScopeInitialization({
      secrets: { status: 'ready', items: [] },
      connector_connections: {
        status: 'ready',
        items: [
          {
            slug: 'computer',
            name: 'Computer',
            authorization_strategy: 'project',
            connections: [
              {
                connection_id: 'connection-computer-default',
                label: 'Project computer',
                is_default: true,
              },
            ],
          },
          {
            slug: 'gmail',
            name: 'Gmail',
            authorization_strategy: 'user',
            connections: [
              {
                connection_id: 'connection-gmail-default',
                label: 'Personal Gmail',
                is_default: true,
              },
            ],
          },
        ],
      },
    });

    expect(
      buildNewSessionCreateInput({
        agent: 'kortix',
        scope: initialization.commit,
      }),
    ).toEqual({
      agent_name: 'kortix',
    });
  });

  it('keeps an explicit empty connector selection fail-closed', () => {
    expect(
      buildNewSessionCreateInput({
        agent: 'kortix',
        scope: {
          draft: {
            connector_bindings: {},
          },
          availability: { secrets: true, connector_bindings: true },
        },
      }),
    ).toEqual({
      agent_name: 'kortix',
      connector_bindings: {},
      inherit_unbound: false,
    });
  });

  it('does not bind connectors when their catalog was unavailable', () => {
    expect(
      buildNewSessionCreateInput({
        scope: {
          draft: {
            connector_bindings: {
              mail: { connection_id: 'connection-mail-private' },
            },
          },
          availability: { secrets: true, connector_bindings: false },
        },
      }),
    ).toBeUndefined();
  });
});
