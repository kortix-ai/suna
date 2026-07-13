import { describe, test, expect } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  kortixSchema,
  sandboxStatusEnum,
  sandboxProviderEnum,
  projectStatusEnum,
  projectSessionStatusEnum,
  sessionLifecycleCommandStatusEnum,
  projectRoleEnum,
  projectAccessRequestStatusEnum,
  apiKeyStatusEnum,
  apiKeyTypeEnum,
  accountRoleEnum,
  scopeEffectEnum,
  tunnelStatusEnum,
  platformRoleEnum,
  changeRequestStatusEnum,
  accounts,
  accountMembers,
  projects,
  projectMembers,
  projectGroupGrants,
  projectGitConnections,
  projectLlmRoutingPolicies,
  sandboxes,
  sandboxMembers,
  kortixApiKeys,
  sandboxComputeSessions,
} from './kortix';

function columnNames(table: any): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

function indexNames(table: any): (string | undefined)[] {
  return getTableConfig(table).indexes.map((i) => i.config.name);
}

function primaryColumn(table: any): string | undefined {
  return getTableConfig(table).columns.find((c) => c.primary)?.name;
}

describe('kortix pgSchema', () => {
  test('declares the kortix schema namespace', () => {
    expect(kortixSchema.schemaName).toBe('kortix');
  });

  test('all sampled tables live in the kortix schema', () => {
    const tables = [accounts, projects, sandboxes, kortixApiKeys];
    for (const t of tables) {
      expect(getTableConfig(t).schema).toBe('kortix');
    }
  });
});

describe('kortix enums', () => {
  test('sandbox_status enum has the expected ordered values', () => {
    expect(sandboxStatusEnum.enumName).toBe('sandbox_status');
    expect(sandboxStatusEnum.enumValues).toEqual([
      'provisioning',
      'active',
      'stopped',
      'archived',
      'error',
    ]);
  });

  test('sandbox_provider enum lists supported providers', () => {
    expect(sandboxProviderEnum.enumName).toBe('sandbox_provider');
    expect(sandboxProviderEnum.enumValues).toEqual([
      'daytona',
      'platinum',
      'e2b',
    ]);
  });

  test('project_status enum is active or archived', () => {
    expect(projectStatusEnum.enumValues).toEqual(['active', 'archived']);
  });

  test('project_session_status enum covers the session lifecycle', () => {
    expect(projectSessionStatusEnum.enumValues).toEqual([
      'queued',
      'branching',
      'provisioning',
      'running',
      'stopped',
      'failed',
      'completed',
    ]);
  });

  test('session_lifecycle_command_status enum includes dead_lettered', () => {
    expect(sessionLifecycleCommandStatusEnum.enumName).toBe(
      'session_lifecycle_command_status',
    );
    expect(sessionLifecycleCommandStatusEnum.enumValues).toContain('dead_lettered');
  });

  test('project_role enum carries manager, editor, member, and the deprecated viewer', () => {
    // `viewer` is retired (folded into `member`) but remains in the enum because
    // Postgres can't drop an enum member — nothing reads or writes it.
    expect(projectRoleEnum.enumValues).toEqual(['manager', 'editor', 'member', 'viewer']);
  });

  test('project_access_request_status enum has the expected values', () => {
    expect(projectAccessRequestStatusEnum.enumValues).toEqual([
      'pending',
      'approved',
      'rejected',
    ]);
  });

  test('api_key_status enum has the expected values', () => {
    expect(apiKeyStatusEnum.enumValues).toEqual(['active', 'revoked', 'expired']);
  });

  test('api_key_type enum distinguishes user and sandbox keys', () => {
    expect(apiKeyTypeEnum.enumValues).toEqual(['user', 'sandbox']);
  });

  test('account_role enum is ordered owner, admin, member', () => {
    expect(accountRoleEnum.enumValues).toEqual(['owner', 'admin', 'member']);
  });

  test('scope_effect enum is grant or revoke', () => {
    expect(scopeEffectEnum.enumValues).toEqual(['grant', 'revoke']);
  });

  test('platform_role enum is non-empty and named', () => {
    expect(platformRoleEnum.enumName).toBe('platform_role');
    expect(platformRoleEnum.enumValues.length).toBeGreaterThan(0);
  });

  test('tunnel_status enum is non-empty and named', () => {
    expect(tunnelStatusEnum.enumName).toBe('tunnel_status');
    expect(tunnelStatusEnum.enumValues.length).toBeGreaterThan(0);
  });

  test('change_request_status enum is non-empty and named', () => {
    expect(changeRequestStatusEnum.enumName).toBe('change_request_status');
    expect(changeRequestStatusEnum.enumValues.length).toBeGreaterThan(0);
  });
});

describe('sandbox compute provider attribution', () => {
  test('compute windows persist the provider and index it with start time', () => {
    expect(columnNames(sandboxComputeSessions)).toContain('provider');
    expect(indexNames(sandboxComputeSessions)).toContain(
      'idx_sandbox_compute_sessions_provider_time',
    );
  });
});

describe('accounts table', () => {
  test('maps to the accounts table name', () => {
    expect(getTableConfig(accounts).name).toBe('accounts');
  });

  test('uses account_id as its single-column primary key', () => {
    expect(primaryColumn(accounts)).toBe('account_id');
  });

  test('exposes the expected core columns', () => {
    const cols = columnNames(accounts);
    expect(cols).toContain('name');
    expect(cols).toContain('mfa_required');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  test('name column is not null', () => {
    const name = getTableConfig(accounts).columns.find((c) => c.name === 'name');
    expect(name?.notNull).toBe(true);
  });

  test('mfa_required defaults to false', () => {
    const col = getTableConfig(accounts).columns.find((c) => c.name === 'mfa_required');
    expect(col?.default).toBe(false);
  });
});

describe('account_members table', () => {
  test('maps to the account_members table name', () => {
    expect(getTableConfig(accountMembers).name).toBe('account_members');
  });

  test('declares a composite primary key on user_id and account_id', () => {
    const pks = getTableConfig(accountMembers).primaryKeys;
    expect(pks).toHaveLength(1);
    const pkColumns = pks[0]!.columns.map((c) => c.name);
    expect(pkColumns).toEqual(['user_id', 'account_id']);
  });

  test('has a foreign key back to accounts', () => {
    const fks = getTableConfig(accountMembers).foreignKeys;
    expect(fks.length).toBeGreaterThan(0);
  });

  test('defines the documented indexes', () => {
    const idx = indexNames(accountMembers);
    expect(idx).toContain('idx_account_members_user_id');
    expect(idx).toContain('idx_account_members_account_id');
    expect(idx).toContain('idx_account_members_user_account');
  });

  test('account_role defaults to owner', () => {
    const col = getTableConfig(accountMembers).columns.find(
      (c) => c.name === 'account_role',
    );
    expect(col?.default).toBe('owner');
  });
});

describe('projects table', () => {
  test('maps to the projects table name', () => {
    expect(getTableConfig(projects).name).toBe('projects');
  });

  test('uses project_id as its primary key', () => {
    expect(primaryColumn(projects)).toBe('project_id');
  });

  test('references accounts via a foreign key', () => {
    const fks = getTableConfig(projects).foreignKeys;
    expect(fks.length).toBeGreaterThan(0);
    const referenced = fks.map((f) => getTableConfig(f.reference().foreignTable).name);
    expect(referenced).toContain('accounts');
  });

  test('default_branch defaults to main', () => {
    const col = getTableConfig(projects).columns.find((c) => c.name === 'default_branch');
    expect(col?.default).toBe('main');
  });

  test('manifest_path defaults to kortix.yaml', () => {
    const col = getTableConfig(projects).columns.find((c) => c.name === 'manifest_path');
    expect(col?.default).toBe('kortix.yaml');
  });

  test('status defaults to active', () => {
    const col = getTableConfig(projects).columns.find((c) => c.name === 'status');
    expect(col?.default).toBe('active');
  });

  test('enforces a unique account/repo index', () => {
    const cfg = getTableConfig(projects);
    const unique = cfg.indexes.find((i) => i.config.name === 'idx_projects_account_repo');
    expect(unique).toBeDefined();
    expect(unique?.config.unique).toBe(true);
  });
});

describe('project_llm_routing_policies table', () => {
  test('stores one versioned routing document per project with audit fields', () => {
    expect(getTableConfig(projectLlmRoutingPolicies).name).toBe('project_llm_routing_policies');
    expect(primaryColumn(projectLlmRoutingPolicies)).toBe('project_id');
    expect(columnNames(projectLlmRoutingPolicies)).toEqual(expect.arrayContaining([
      'vision_model',
      'default_fallback_models',
      'default_fallback_on',
      'rules',
      'updated_by',
      'created_at',
      'updated_at',
    ]));
  });
});

describe('project_members table', () => {
  test('project_role defaults to member (the floor role)', () => {
    const col = getTableConfig(projectMembers).columns.find(
      (c) => c.name === 'project_role',
    );
    expect(col?.default).toBe('member');
  });

  test('enforces a unique project/user index', () => {
    const cfg = getTableConfig(projectMembers);
    const unique = cfg.indexes.find(
      (i) => i.config.name === 'idx_project_members_project_user',
    );
    expect(unique?.config.unique).toBe(true);
  });
});

describe('project_group_grants table', () => {
  test('stores an optional default base ref for sessions started by group members', () => {
    const col = getTableConfig(projectGroupGrants).columns.find(
      (column) => column.name === 'default_base_ref',
    );
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });
});

describe('project_git_connections table', () => {
  test('maps to the project_git_connections table name', () => {
    expect(getTableConfig(projectGitConnections).name).toBe('project_git_connections');
  });

  test('managed flag defaults to false', () => {
    const col = getTableConfig(projectGitConnections).columns.find(
      (c) => c.name === 'managed',
    );
    expect(col?.default).toBe(false);
  });

  test('enforces a unique project index', () => {
    const cfg = getTableConfig(projectGitConnections);
    const unique = cfg.indexes.find(
      (i) => i.config.name === 'idx_project_git_connections_project',
    );
    expect(unique?.config.unique).toBe(true);
  });
});

describe('sandboxes table', () => {
  test('maps to the sandboxes table name', () => {
    expect(getTableConfig(sandboxes).name).toBe('sandboxes');
  });

  test('uses sandbox_id as its primary key', () => {
    expect(primaryColumn(sandboxes)).toBe('sandbox_id');
  });

  test('provider defaults to daytona', () => {
    const col = getTableConfig(sandboxes).columns.find((c) => c.name === 'provider');
    expect(col?.default).toBe('daytona');
  });

  test('status defaults to provisioning', () => {
    const col = getTableConfig(sandboxes).columns.find((c) => c.name === 'status');
    expect(col?.default).toBe('provisioning');
  });

  test('base_url is not null', () => {
    const col = getTableConfig(sandboxes).columns.find((c) => c.name === 'base_url');
    expect(col?.notNull).toBe(true);
  });

  test('is_included billing flag defaults to false', () => {
    const col = getTableConfig(sandboxes).columns.find((c) => c.name === 'is_included');
    expect(col?.default).toBe(false);
  });
});

describe('sandbox_members table', () => {
  test('enforces a unique sandbox/user index', () => {
    const cfg = getTableConfig(sandboxMembers);
    const unique = cfg.indexes.find((i) => i.config.name === 'idx_sandbox_members_unique');
    expect(unique?.config.unique).toBe(true);
  });

  test('current_period_cents defaults to zero', () => {
    const col = getTableConfig(sandboxMembers).columns.find(
      (c) => c.name === 'current_period_cents',
    );
    expect(col?.default).toBe(0);
  });
});

describe('kortixApiKeys table', () => {
  test('maps to the api_keys table name inside the kortix schema', () => {
    const cfg = getTableConfig(kortixApiKeys);
    expect(cfg.name).toBe('api_keys');
    expect(cfg.schema).toBe('kortix');
  });

  test('uses key_id as its primary key', () => {
    expect(primaryColumn(kortixApiKeys)).toBe('key_id');
  });

  test('type defaults to user and status defaults to active', () => {
    const cols = getTableConfig(kortixApiKeys).columns;
    expect(cols.find((c) => c.name === 'type')?.default).toBe('user');
    expect(cols.find((c) => c.name === 'status')?.default).toBe('active');
  });

  test('enforces a unique public_key index', () => {
    const cfg = getTableConfig(kortixApiKeys);
    const unique = cfg.indexes.find(
      (i) => i.config.name === 'idx_kortix_api_keys_public_key',
    );
    expect(unique?.config.unique).toBe(true);
  });
});
