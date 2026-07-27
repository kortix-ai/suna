import { describe, expect, test } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { accountGithubInstallations } from './kortix';

const NANGO_COLUMNS = [
  'nango_connection_id',
  'nango_integration_id',
  'connection_status',
  'last_validated_at',
  'last_error_code',
  'last_error_message',
  'disconnected_at',
] as const;

function indexColumnName(column: unknown): string | undefined {
  if (!column || typeof column !== 'object' || !('name' in column)) {
    return undefined;
  }
  return typeof column.name === 'string' ? column.name : undefined;
}

describe('account GitHub connection schema', () => {
  test('stores GitHub installation and Nango connection identifiers separately', () => {
    const columns = getTableConfig(accountGithubInstallations).columns;
    const installationId = columns.find((column) => column.name === 'installation_id');
    const nangoConnectionId = columns.find((column) => column.name === 'nango_connection_id');

    expect(installationId?.getSQLType()).toBe('text');
    expect(nangoConnectionId?.getSQLType()).toBe('text');
    expect(installationId?.name).not.toBe(nangoConnectionId?.name);
  });

  test('keeps all Nango fields nullable for legacy rows', () => {
    const columns = getTableConfig(accountGithubInstallations).columns;

    for (const name of NANGO_COLUMNS) {
      const column = columns.find((candidate) => candidate.name === name);
      expect(column, `missing ${name}`).toBeDefined();
      expect(column?.notNull, `${name} must remain nullable`).toBe(false);
    }
  });

  test('allows accounts to share a GitHub installation identifier', () => {
    const index = getTableConfig(accountGithubInstallations).indexes.find(
      (candidate) =>
        candidate.config.name === 'idx_account_github_installations_account_installation',
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map(indexColumnName)).toEqual(['account_id', 'installation_id']);
  });

  test('uniquely binds each non-null Nango connection identifier', () => {
    const index = getTableConfig(accountGithubInstallations).indexes.find(
      (candidate) => candidate.config.name === 'idx_account_github_installations_nango_connection',
    );

    expect(index).toBeDefined();
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map(indexColumnName)).toEqual(['nango_connection_id']);
    expect(index?.config.where).toBeDefined();
  });

  test('constrains connection status to the lifecycle state machine', () => {
    const checkNames = getTableConfig(accountGithubInstallations).checks.map(
      (candidate) => candidate.name,
    );

    expect(checkNames).toContain('account_github_installations_connection_status_check');
  });
});
