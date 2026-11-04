/**
 * Sync seeds no empty "Everyone in project" account (KRTX-2317) for ordinary
 * connectors; a channel connector (the install token is the project's own
 * identity) and a public server (no auth: the account is the connection) keep it.
 */
import { expect, test } from 'bun:test';
import type { ConnectorSpec } from '../projects/connectors';
import { skipsEmptyProjectAccount } from './sync';

const spec = (provider: ConnectorSpec['provider'], auth?: ConnectorSpec['auth']) => ({ provider, auth }) as ConnectorSpec;

test('only an ordinary connector skips the empty project account', () => {
  expect(skipsEmptyProjectAccount(spec('mcp'))).toBe(true);
  expect(skipsEmptyProjectAccount(spec('mcp', { type: 'none' } as ConnectorSpec['auth']))).toBe(false);
  expect(skipsEmptyProjectAccount(spec('composio'))).toBe(true);
  expect(skipsEmptyProjectAccount(spec('channel'))).toBe(false);
});
