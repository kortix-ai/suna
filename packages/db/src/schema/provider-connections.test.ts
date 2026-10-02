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

test('the project owner FK has a covering index for its cascade probe', () => {
  const table = getTableConfig(projectUserProviderConnections);
  const owner = table.foreignKeys.find(
    (key) => key.getName() === 'project_user_provider_connections_owner_fk',
  );
  expect(owner?.reference().columns.map((column) => column.name)).toEqual([
    'connection_id',
    'user_id',
    'provider_id',
  ]);
  // The Supabase unindexed-foreign-keys advisor flags an FK no index covers:
  // a cascade delete on user_provider_connections probes this table with all
  // three columns, and the connection-only index does not match that column
  // set (KRTX-1110). Some index must lead with them, in FK order.
  expect(
    table.indexes
      .map((index) => index.config.columns.map((column) => ('name' in column ? column.name : null)))
      .some((names) => names.slice(0, 3).join(',') === 'connection_id,user_id,provider_id'),
  ).toBe(true);
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
