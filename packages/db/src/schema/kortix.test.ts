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
  creditAccounts,
  creditLedger,
  usageEvents,
  gatewayRequestLogs,
  accountSsoProviders,
  agiTasks,
  agiObservations,
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
    expect(sandboxProviderEnum.enumValues).toEqual(['daytona', 'platinum', 'e2b', 'local-docker']);
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
    expect(sessionLifecycleCommandStatusEnum.enumName).toBe('session_lifecycle_command_status');
    expect(sessionLifecycleCommandStatusEnum.enumValues).toContain('dead_lettered');
  });

  test('project_role enum carries manager, editor, member, and the deprecated viewer', () => {
    // `viewer` is retired (folded into `member`) but remains in the enum because
    // Postgres can't drop an enum member — nothing reads or writes it.
    expect(projectRoleEnum.enumValues).toEqual(['manager', 'editor', 'member', 'viewer']);
  });

  test('project_access_request_status enum has the expected values', () => {
    expect(projectAccessRequestStatusEnum.enumValues).toEqual(['pending', 'approved', 'rejected']);
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

describe('billing precision', () => {
  test('wallet and ledger columns preserve sub-cent LLM charges', () => {
    for (const [table, names] of [
      [
        creditAccounts,
        [
          'balance_precise',
          'expiring_credits_precise',
          'non_expiring_credits_precise',
          'daily_credits_balance_precise',
        ],
      ],
      [creditLedger, ['amount_precise', 'balance_after_precise']],
      [usageEvents, ['cost_usd_precise']],
      [gatewayRequestLogs, ['upstream_cost_precise', 'final_cost_precise']],
    ] as const) {
      const columnNamesToCheck: readonly string[] = names;
      const columns = getTableConfig(table).columns.filter((column) =>
        columnNamesToCheck.includes(column.name),
      );
      expect(columns).toHaveLength(names.length);
      for (const column of columns) {
        expect(column.getSQLType()).toBe('numeric(20, 10)');
      }
    }
  });

  test('gateway logs store cache-write tokens directly', () => {
    expect(columnNames(gatewayRequestLogs)).toContain('cache_write_tokens');
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
    const col = getTableConfig(accountMembers).columns.find((c) => c.name === 'account_role');
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

  test('indexes account/repo without preventing branch-isolated projects', () => {
    const cfg = getTableConfig(projects);
    const accountRepo = cfg.indexes.find((i) => i.config.name === 'idx_projects_account_repo');
    expect(accountRepo).toBeDefined();
    expect(accountRepo?.config.unique).toBe(false);
  });
});

describe('project_llm_routing_policies table', () => {
  test('stores one versioned routing document per project with audit fields', () => {
    expect(getTableConfig(projectLlmRoutingPolicies).name).toBe('project_llm_routing_policies');
    expect(primaryColumn(projectLlmRoutingPolicies)).toBe('project_id');
    expect(columnNames(projectLlmRoutingPolicies)).toEqual(
      expect.arrayContaining([
        'vision_model',
        'default_fallback_models',
        'default_fallback_on',
        'rules',
        'updated_by',
        'created_at',
        'updated_at',
      ]),
    );
  });
});

describe('project_members table', () => {
  test('project_role defaults to member (the floor role)', () => {
    const col = getTableConfig(projectMembers).columns.find((c) => c.name === 'project_role');
    expect(col?.default).toBe('member');
  });

  test('enforces a unique project/user index', () => {
    const cfg = getTableConfig(projectMembers);
    const unique = cfg.indexes.find((i) => i.config.name === 'idx_project_members_project_user');
    expect(unique?.config.unique).toBe(true);
  });
});

describe('project_group_grants table', () => {
  test('does not carry branch selection outside the project boundary', () => {
    const col = getTableConfig(projectGroupGrants).columns.find(
      (column) => column.name === 'default_base_ref',
    );
    expect(col).toBeUndefined();
  });
});

describe('project_git_connections table', () => {
  test('maps to the project_git_connections table name', () => {
    expect(getTableConfig(projectGitConnections).name).toBe('project_git_connections');
  });

  test('managed flag defaults to false', () => {
    const col = getTableConfig(projectGitConnections).columns.find((c) => c.name === 'managed');
    expect(col?.default).toBe(false);
  });

  test('enforces a unique project index', () => {
    const cfg = getTableConfig(projectGitConnections);
    const unique = cfg.indexes.find((i) => i.config.name === 'idx_project_git_connections_project');
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
    const unique = cfg.indexes.find((i) => i.config.name === 'idx_kortix_api_keys_public_key');
    expect(unique?.config.unique).toBe(true);
  });
});

describe('accountSsoProviders table', () => {
  test('maps to account_sso_providers inside the kortix schema', () => {
    const cfg = getTableConfig(accountSsoProviders);
    expect(cfg.name).toBe('account_sso_providers');
    expect(cfg.schema).toBe('kortix');
  });

  test('enforce_sso is a not-null boolean defaulting to false', () => {
    const col = getTableConfig(accountSsoProviders).columns.find((c) => c.name === 'enforce_sso');
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.default).toBe(false);
  });
});

describe('agi_tasks table', () => {
  const cfg = getTableConfig(agiTasks);
  const checkNames = cfg.checks.map((c) => c.name);
  const column = (name: string) => cfg.columns.find((c) => c.name === name);
  const index = (name: string) => cfg.indexes.find((i) => i.config.name === name);

  test('lives in the kortix schema under the gate-prefixed name', () => {
    expect(cfg.name).toBe('agi_tasks');
    expect(cfg.schema).toBe('kortix');
    expect(primaryColumn(agiTasks)).toBe('task_id');
  });

  test('carries every column from spec section 5', () => {
    expect(columnNames(agiTasks)).toEqual(
      expect.arrayContaining([
        'task_id',
        'workspace_id',
        'parent_id',
        'goal_slug',
        'project',
        'title',
        'body',
        'status',
        'priority',
        'agent',
        'assignee_user_id',
        'blocked_by',
        'trigger_slug',
        'claim_session_id',
        'claimed_at',
        'claim_expires_at',
        'origin',
        'origin_fingerprint',
        'created_at',
        'updated_at',
      ]),
    );
  });

  test('cascades from the workspace project and self-references parent_id', () => {
    const targets = cfg.foreignKeys.map((f) => ({
      table: getTableConfig(f.reference().foreignTable).name,
      columns: f.reference().columns.map((c) => c.name),
    }));
    expect(targets).toContainEqual({ table: 'projects', columns: ['workspace_id'] });
    expect(targets).toContainEqual({ table: 'agi_tasks', columns: ['parent_id'] });
  });

  test('R-14: a check constraint, not convention, forbids two assignees', () => {
    expect(checkNames).toContain('agi_tasks_single_assignee_check');
    expect(column('agent')?.notNull).toBe(false);
    expect(column('assignee_user_id')?.notNull).toBe(false);
  });

  test('R-15/R-16: structure and dependency are separate columns', () => {
    expect(column('parent_id')?.getSQLType()).toBe('uuid');
    expect(column('blocked_by')?.getSQLType()).toBe('uuid[]');
    expect(column('blocked_by')?.notNull).toBe(true);
    expect(column('blocked_by')?.default).toEqual([]);
  });

  test('R-18: the claim is a three-column atom so the predicate is total', () => {
    // A null claim_expires_at under a held claim would make
    // `claim_expires_at < now()` evaluate to NULL, stranding the row as
    // permanently unclaimable — the coherence check is what rules that out.
    expect(checkNames).toContain('agi_tasks_claim_coherent_check');
    for (const name of ['claim_session_id', 'claimed_at', 'claim_expires_at']) {
      expect(column(name)?.notNull).toBe(false);
    }
    // Must join project_sessions.session_id, which is text.
    expect(column('claim_session_id')?.getSQLType()).toBe('text');
  });

  test('R-20: origin_fingerprint is unique per workspace only where present', () => {
    const fingerprint = index('uq_agi_tasks_origin_fingerprint');
    expect(fingerprint?.config.unique).toBe(true);
    const fingerprintColumns = fingerprint?.config.columns.map(
      (c) => (c as { name?: string }).name,
    );
    expect(fingerprintColumns).toEqual(['workspace_id', 'origin_fingerprint']);
    expect(fingerprint?.config.where).toBeDefined();
  });

  test('indexes the two hot reads: open tasks per workspace and per goal', () => {
    expect(index('idx_agi_tasks_workspace_open')?.config.where).toBeDefined();
    expect(index('idx_agi_tasks_goal_open')?.config.where).toBeDefined();
    expect(index('idx_agi_tasks_claimable')?.config.where).toBeDefined();
  });

  test('reverse dependency lookup is served by a gin index on blocked_by', () => {
    expect(index('idx_agi_tasks_blocked_by')?.config.method).toBe('gin');
  });

  test('status, priority, and origin are constrained vocabularies', () => {
    expect(checkNames).toContain('agi_tasks_status_check');
    expect(checkNames).toContain('agi_tasks_priority_check');
    expect(checkNames).toContain('agi_tasks_origin_check');
    expect(column('status')?.default).toBe('backlog');
    expect(column('priority')?.default).toBe('medium');
    expect(column('origin')?.notNull).toBe(true);
  });

  test('a task cannot be its own parent', () => {
    expect(checkNames).toContain('agi_tasks_parent_not_self_check');
  });
});

describe('agi_observations table', () => {
  const cfg = getTableConfig(agiObservations);
  const checkNames = cfg.checks.map((c) => c.name);
  const column = (name: string) => cfg.columns.find((c) => c.name === name);
  const index = (name: string) => cfg.indexes.find((i) => i.config.name === name);

  test('lives in the kortix schema under the gate-prefixed name', () => {
    expect(cfg.name).toBe('agi_observations');
    expect(cfg.schema).toBe('kortix');
    expect(primaryColumn(agiObservations)).toBe('observation_id');
  });

  test('carries every column from spec R-12b, plus the workspace scope', () => {
    expect(columnNames(agiObservations)).toEqual([
      'observation_id',
      'workspace_id',
      'goal_slug',
      'metric',
      'value',
      'observed_at',
      'source',
      'created_at',
    ]);
  });

  test('is APPEND-ONLY: there is no updated_at to write', () => {
    // R-12f makes an observation evidence and never authority. A series that can
    // be edited after the fact proves nothing, so the schema has no mutable
    // column to edit.
    expect(columnNames(agiObservations)).not.toContain('updated_at');
  });

  test('cascades from the workspace project and has NO foreign key to a goal', () => {
    const targets = cfg.foreignKeys.map((f) => ({
      table: getTableConfig(f.reference().foreignTable).name,
      columns: f.reference().columns.map((c) => c.name),
    }));
    // Goals are authored state in kortix.yaml. Deleting or renaming one must not
    // delete the measurements that judged it — same rule agi_tasks follows.
    expect(targets).toEqual([{ table: 'projects', columns: ['workspace_id'] }]);
    expect(column('goal_slug')?.notNull).toBe(true);
  });

  test('value is double precision, not numeric', () => {
    // A JSON number IS an IEEE-754 double, so numeric would promise precision the
    // wire cannot keep — and node-postgres returns numeric as a string, which
    // would serialize as `"3"` and break every comparison built on this column.
    expect(column('value')?.getSQLType()).toBe('double precision');
    expect(column('value')?.notNull).toBe(true);
  });

  test('rejects NaN and both infinities, which would otherwise pin the latest value', () => {
    expect(checkNames).toContain('agi_observations_value_finite_check');
  });

  test('constrains the metric name shape so a series cannot fork on a spelling', () => {
    expect(checkNames).toContain('agi_observations_metric_check');
  });

  test('one index serves both the latest-value read and the range scan', () => {
    const series = index('idx_agi_observations_series');
    expect(series?.config.columns.map((c) => (c as { name?: string }).name)).toEqual([
      'workspace_id',
      'goal_slug',
      'metric',
      'observed_at',
      'observation_id',
    ]);
    // Descending on observed_at is what makes "latest" a LIMIT 1 rather than a
    // sort; observation_id is the deterministic tiebreak for two readings that
    // share a timestamp.
    expect(
      series?.config.columns.map((c) => (c as { indexConfig?: { order?: string } }).indexConfig?.order),
    ).toEqual(['asc', 'asc', 'asc', 'desc', 'desc']);
  });

  test('observed_at and created_at are separate facts, both defaulted', () => {
    // A webhook relaying an outside reading carries the reading's own timestamp;
    // ordering the series by arrival would misdate it.
    for (const name of ['observed_at', 'created_at']) {
      expect(column(name)?.notNull).toBe(true);
      expect(column(name)?.hasDefault).toBe(true);
    }
  });

  test('source is required — an unattributed number is not evidence', () => {
    expect(column('source')?.notNull).toBe(true);
    expect(column('source')?.hasDefault).toBe(false);
  });
});
