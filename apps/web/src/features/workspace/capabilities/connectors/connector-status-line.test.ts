import type { AdminConnector } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  connectorErrorExplanation,
  connectorStatusLine,
  connectorStatusShort,
  connectorStatusStatement,
  connectorStatusTone,
} from './connector-status-line';

const conn = (over: Partial<AdminConnector> = {}): AdminConnector =>
  ({
    slug: 'linear',
    name: 'Linear',
    provider: 'mcp',
    status: 'active',
    credentialMode: 'shared',
    authorizationStrategy: 'project',
    sensitive: false,
    actions: [{ path: 'a' }, { path: 'b' }],
    authSecret: 'T',
    secretSet: true,
    ...over,
  }) as AdminConnector;

describe('connectorStatusShort names the next action, not the wire state', () => {
  test('error on a managed provider says to sign in', () => {
    expect(connectorStatusShort(conn({ status: 'error', provider: 'composio' }))).toBe(
      'Needs sign-in',
    );
  });

  test('error with a declared, unset secret says to add a credential, regardless of provider', () => {
    expect(
      connectorStatusShort(conn({ status: 'error', secretSet: false, provider: 'composio' })),
    ).toBe('Needs a credential');
  });

  test('error on a non-managed provider with no credential problem says the connection is not working', () => {
    expect(connectorStatusShort(conn({ status: 'error' }))).toBe(
      'Not working — check the connection',
    );
  });

  test('needs_setup on a managed provider says to sign in', () => {
    expect(connectorStatusShort(conn({ secretSet: false, provider: 'pipedream' }))).toBe(
      'Needs sign-in',
    );
  });

  test('needs_setup on a secret-based provider says to add a credential', () => {
    expect(connectorStatusShort(conn({ secretSet: false }))).toBe('Needs a credential');
  });

  test('connected with tools synced reads as Connected', () => {
    expect(connectorStatusShort(conn())).toBe('Connected');
  });

  test('connected with no tools yet reads as Syncing, not a broken 0-tools state', () => {
    expect(connectorStatusShort(conn({ actions: [] }))).toBe('Syncing…');
  });

  test('no_auth with no tools yet also reads as Syncing', () => {
    expect(connectorStatusShort(conn({ authSecret: null, actions: [] } as never))).toBe('Syncing…');
  });

  test('no_auth with tools synced reads as Ready', () => {
    expect(connectorStatusShort(conn({ authSecret: null } as never))).toBe('Ready');
  });

  test('user_managed names who signs in', () => {
    expect(connectorStatusShort(conn({ authorizationStrategy: 'user' }))).toBe(
      'Each member signs in',
    );
  });
});

describe('connectorStatusLine leads with the state, keeps the searchable meta', () => {
  test('connected', () => {
    expect(connectorStatusLine(conn(), 'MCP')).toBe('Connected · 2 tools · MCP');
  });

  test('needs_setup names the credential, not the protocol', () => {
    expect(connectorStatusLine(conn({ secretSet: false }), 'MCP')).toBe(
      'Needs a credential · 2 tools · MCP',
    );
  });

  test('error wins over everything', () => {
    expect(connectorStatusLine(conn({ status: 'error' }), 'MCP')).toStartWith('Not working');
  });

  test('user_managed says whose account it runs as', () => {
    expect(connectorStatusLine(conn({ authorizationStrategy: 'user' }), 'App')).toBe(
      'Each member signs in · 2 tools · App',
    );
  });

  test('no declared credential reads as ready, and singular tool is singular', () => {
    expect(
      connectorStatusLine(conn({ authSecret: null, actions: [{ path: 'a' }] } as never), 'HTTP'),
    ).toBe('Ready · 1 tool · HTTP');
  });

  test('3 tools is named in the line', () => {
    expect(
      connectorStatusLine(
        conn({ actions: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] } as never),
        'MCP',
      ),
    ).toContain('3 tools');
  });

  test('0 tools drops the count instead of printing a broken-looking "0 tools"', () => {
    const line = connectorStatusLine(conn({ actions: [] }), 'MCP');
    expect(line).not.toContain('0 tools');
    expect(line).toBe('Syncing… · MCP');
  });

  test('the provider label survives in every variant — it is what search matches', () => {
    for (const c of [
      conn(),
      conn({ secretSet: false }),
      conn({ status: 'error' }),
      conn({ authorizationStrategy: 'user' }),
      conn({ authSecret: null } as never),
    ]) {
      expect(connectorStatusLine(c, 'PROBE')).toEndWith('· PROBE');
    }
  });
});

describe('connectorStatusTone maps to the design-system state table', () => {
  test('connected → ok, needs_setup → attention, error → error, rest neutral', () => {
    expect(connectorStatusTone('connected')).toBe('ok');
    expect(connectorStatusTone('needs_setup')).toBe('attention');
    expect(connectorStatusTone('error')).toBe('error');
    expect(connectorStatusTone('user_managed')).toBe('neutral');
    expect(connectorStatusTone('no_auth')).toBe('neutral');
  });
});

describe('connectorStatusStatement is a full sentence with the next move in it', () => {
  test('needs_setup tells the reader to connect', () => {
    expect(connectorStatusStatement(conn({ secretSet: false }), 'Linear')).toBe(
      'Not connected yet. Connect an account so agents can use Linear.',
    );
  });

  test('connected confirms agents can use it', () => {
    expect(connectorStatusStatement(conn(), 'Linear')).toContain('Agents can use Linear');
  });

  test('error points at the fix', () => {
    expect(connectorStatusStatement(conn({ status: 'error' }), 'Linear')).toContain('Reconnect');
  });
});

describe('connectorErrorExplanation translates the stored reason into a next step', () => {
  test('an auth refusal says to connect or fix the credential', () => {
    expect(connectorErrorExplanation('MCP tools/list failed: HTTP 401')).toContain(
      'Connect an account or fix the credential',
    );
    expect(connectorErrorExplanation('Unauthorized')).toContain('refused our sign-in');
  });

  test('an HTML answer says the URL points at a page, not an API', () => {
    expect(
      connectorErrorExplanation('Unexpected token \'<\', "<!DOCTYPE " is not valid JSON'),
    ).toContain('a web page, not an API');
  });

  test('refused introspection is named as such', () => {
    expect(connectorErrorExplanation('GraphQL introspection is disabled')).toContain(
      'refused schema introspection',
    );
  });

  test('an unknown shape returns null so the caller shows the raw text alone', () => {
    expect(connectorErrorExplanation('some entirely novel failure')).toBeNull();
    expect(connectorErrorExplanation(null)).toBeNull();
    expect(connectorErrorExplanation(undefined)).toBeNull();
  });
});
