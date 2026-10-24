import { describe, expect, test } from 'bun:test';

import {
  connectorPolicySetOptions,
  policySetRows,
  withPolicySet,
} from './agent-policy-sets';

const MANIFEST = `kortix_version: 3
connectors:
  - slug: gmail
    provider: composio
    app: gmail
    policy_sets:
      read_only:
        description: Read and search, never send
        policies:
          - match: send_*
            action: block
      outreach:
        policies: []
  - slug: stripe
    provider: mcp
`;

describe('connectorPolicySetOptions', () => {
  test('reads each connector set with its description', () => {
    expect(connectorPolicySetOptions(MANIFEST)).toEqual({
      gmail: [{ name: 'read_only', description: 'Read and search, never send' }, { name: 'outreach' }],
    });
  });
  test('a manifest that does not parse lists nothing', () => {
    expect(connectorPolicySetOptions('connectors: [')).toEqual({});
    expect(connectorPolicySetOptions(null)).toEqual({});
  });
  test('a connector slug named like an Object property is a plain key', () => {
    const options = connectorPolicySetOptions(
      'connectors:\n  - slug: constructor\n    policy_sets:\n      a: {}\n',
    );
    expect(Object.entries(options)).toEqual([['constructor', [{ name: 'a' }]]]);
    expect(Object.hasOwn(connectorPolicySetOptions(MANIFEST), 'constructor')).toBe(false);
    expect('constructor' in connectorPolicySetOptions(MANIFEST)).toBe(false);
  });
});

describe('withPolicySet', () => {
  test('sets, replaces and clears one connector', () => {
    expect(withPolicySet(undefined, 'gmail', 'read_only')).toEqual({ gmail: 'read_only' });
    expect(withPolicySet({ gmail: 'read_only' }, 'gmail', 'outreach')).toEqual({ gmail: 'outreach' });
    // `{}`, not undefined: an omitted key keeps the declared sets on the server.
    expect(withPolicySet({ gmail: 'read_only' }, 'gmail', null)).toEqual({});
    expect(withPolicySet({ gmail: 'read_only', x: 'y' }, 'gmail', 'base')).toEqual({ x: 'y' });
  });
});

describe('policySetRows', () => {
  const catalog = connectorPolicySetOptions(MANIFEST);
  test('lists granted connectors that define sets', () => {
    expect(policySetRows(['gmail', 'stripe'], catalog, undefined, ['gmail', 'stripe'])).toEqual([
      { slug: 'gmail', options: catalog.gmail!, value: null, missing: false },
    ]);
  });
  test('all grants every connector with sets', () => {
    expect(policySetRows('all', catalog, { gmail: 'outreach' }, ['gmail', 'stripe'])).toEqual([
      { slug: 'gmail', options: catalog.gmail!, value: 'outreach', missing: false },
    ]);
  });
  test('a set the connector does not define is flagged missing', () => {
    const [row] = policySetRows(['gmail'], catalog, { gmail: 'gone' }, ['gmail']);
    expect(row).toMatchObject({ value: 'gone', missing: true });
  });
  test('an entry on a connector without sets still shows, so it can be cleared', () => {
    expect(policySetRows(['stripe'], catalog, { stripe: 'x' }, ['gmail', 'stripe'])).toEqual([
      { slug: 'stripe', options: [], value: 'x', missing: true },
    ]);
  });
  test('an ungranted connector is not listed', () => {
    expect(policySetRows(['stripe'], catalog, undefined, ['gmail', 'stripe'])).toEqual([]);
  });
});
