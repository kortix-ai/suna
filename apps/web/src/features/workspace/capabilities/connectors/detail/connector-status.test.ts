import { describe, expect, test } from 'bun:test';

import { connectorUsable } from './connector-status';

// KRTX-2185: an MCP server with no sign-in (DeepWiki) loaded its tools and
// agents used them, but its page said "needs a credential — Agents cannot use
// it until you set one". `no_auth` was not counted as usable.
describe('connectorUsable', () => {
  test('a connector with no sign-in is usable once it has an account to run as', () => {
    expect(connectorUsable('no_auth', 1)).toBe(true);
    expect(connectorUsable('no_auth', 0)).toBe(false);
  });
  test('signed in is usable', () => {
    expect(connectorUsable('connected', 1)).toBe(true);
  });
  test('setup still to do is not usable', () => {
    expect(connectorUsable('needs_setup', 1)).toBe(false);
    expect(connectorUsable('pending', 1)).toBe(false);
    expect(connectorUsable('error', 1)).toBe(false);
  });
});
