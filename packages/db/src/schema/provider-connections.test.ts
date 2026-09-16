import { expect, test } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  projectUserProviderConnections,
  sessionUserProviderConnections,
  userProviderConnections,
} from './kortix';

test('personal connections keep one legacy default slot while permitting named members', () => {
  const table = getTableConfig(userProviderConnections);
  expect(
    table.indexes
      .find((index) => index.config.unique)
      ?.config.columns.map((column) => ('name' in column ? column.name : null)),
  ).toEqual(['user_id', 'provider_id', 'slot']);
  expect(userProviderConnections.slot.default).toBe('default');
  expect(userProviderConnections.label.notNull).toBe(true);
});

test('a project defaults to one connection and explicitly opts into pooling', () => {
  expect(projectUserProviderConnections.pool.default).toBe(false);
  expect(projectUserProviderConnections.pool.notNull).toBe(true);
});

test('session membership binds the credential owner and cascades after credential or session removal', () => {
  const table = getTableConfig(sessionUserProviderConnections);
  expect(table.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
    'session_id',
    'user_id',
    'provider_id',
  ]);
  const owner = table.foreignKeys.find(
    (key) => key.getName() === 'session_user_provider_connections_owner_fk',
  );
  expect(owner?.reference().columns.map((column) => column.name)).toEqual([
    'connection_id',
    'user_id',
    'provider_id',
  ]);
  expect(table.foreignKeys.map((key) => key.onDelete)).toEqual(['cascade', 'cascade']);
});
