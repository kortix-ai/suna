import type { AdminConnector } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  connectorStatusLine,
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

describe('connectorStatusLine leads with the state, keeps the searchable meta', () => {
  test('connected', () => {
    expect(connectorStatusLine(conn(), 'MCP')).toBe('Connected · 2 tools · MCP');
  });

  test('needs_setup names the action, not the field', () => {
    expect(connectorStatusLine(conn({ secretSet: false }), 'MCP')).toBe(
      'Needs setup — connect an account · 2 tools · MCP',
    );
  });

  test('error wins over everything', () => {
    expect(connectorStatusLine(conn({ status: 'error' }), 'MCP')).toStartWith('Error');
  });

  test('user_managed says whose account it runs as', () => {
    expect(connectorStatusLine(conn({ authorizationStrategy: 'user' }), 'App')).toBe(
      'Each member connects their own account · 2 tools · App',
    );
  });

  test('no declared credential reads as ready, and singular tool is singular', () => {
    expect(connectorStatusLine(conn({ authSecret: null, actions: [{ path: 'a' }] } as never), 'HTTP')).toBe(
      'Ready, no sign-in needed · 1 tool · HTTP',
    );
  });

  test('the provider label survives in every variant — it is what search matches', () => {
    for (const c of [
      conn(),
      conn({ secretSet: false }),
      conn({ status: 'error' }),
      conn({ authorizationStrategy: 'user' }),
      conn({ authSecret: null }),
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
