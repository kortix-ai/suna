import { describe, test, expect } from 'bun:test';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  kortixSchema,
  sandboxStatusEnum,
  sandboxProviderEnum,
  projectStatusEnum,
  projectTaskStatusEnum,
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
  projectSessions,
  projectSessionConnectorBindings,
  projectTasks,
  projectTaskNoProgressSettlements,
  projectTaskTurnOutcomes,
  TASK_WORKER_PLATFORM_CEILINGS,
  projectGoalEvaluations,
  projectGoalObservations,
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
  connectorAuthorizationStrategyEnum,
  connectorCalls,
  connectorConnections,
  connectors,
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

  test('project_task_status enum covers the generated task lifecycle', () => {
    expect(projectTaskStatusEnum.enumValues).toEqual([
      'backlog',
      'todo',
      'doing',
      'blocked',
      'review',
      'done',
      'cancelled',
    ]);
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

  test('connector authorization strategy is project or user', () => {
    expect(connectorAuthorizationStrategyEnum.enumName).toBe('connector_authorization_strategy');
    expect(connectorAuthorizationStrategyEnum.enumValues).toEqual(['project', 'user']);
  });
});

describe('connectors', () => {
  test('uses canonical physical database identifiers', () => {
    expect(getTableConfig(connectors).name).toBe('connectors');
    expect(getTableConfig(connectorConnections).name).toBe('connector_connections');
    expect(getTableConfig(connectorCalls).name).toBe('connector_calls');
  });

  test('store one authorization strategy on each connector', () => {
    expect(columnNames(connectors)).toContain('authorization_strategy');
  });

  test('maps connector call identifiers to the transition execution_id column', () => {
    expect(primaryColumn(connectorCalls)).toBe('execution_id');
  });

  test('uses canonical physical index identifiers', () => {
    expect(indexNames(connectors)).toEqual([
      'idx_connectors_project',
      'idx_connectors_account',
      'idx_connectors_project_slug',
      'idx_connectors_tenant_identity',
      'idx_connectors_tenant_alias',
    ]);
    expect(indexNames(connectorConnections)).toEqual([
      'idx_connector_connections_tenant_identity',
      'idx_connector_connections_connector_identity',
      'idx_connector_connections_default_project',
      'idx_connector_connections_default_owner',
      'idx_connector_connections_owner_label',
      'idx_connector_connections_project_label',
      'idx_connector_connections_project',
      'idx_connector_connections_connector',
    ]);
    expect(indexNames(connectorCalls)).toEqual([
      'idx_connector_calls_project',
      'idx_connector_calls_project_session_created',
      'idx_connector_calls_connector',
      'idx_connector_calls_connection',
      'idx_connector_calls_status',
    ]);
  });

  test('uses connection_id for every active connection reference', () => {
    expect(columnNames(connectorConnections)).toContain('connection_id');
    expect(columnNames(connectorConnections)).not.toContain('profile_id');
    expect(columnNames(connectorCalls)).toContain('connection_id');
    expect(columnNames(connectorCalls)).not.toContain('profile_id');
    expect(columnNames(projectSessionConnectorBindings)).toContain('connection_id');
  });
});

describe('project session connector bindings', () => {
  test('store whether connector bindings were configured explicitly', () => {
    const column = getTableConfig(projectSessions).columns.find(
      (candidate) => candidate.name === 'connector_bindings_configured',
    );

    expect(column).toBeDefined();
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(false);
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

describe('warm project session uniqueness', () => {
  test('allows one available warm session per project and creator', () => {
    const index = getTableConfig(projectSessions).indexes.find(
      (candidate) => candidate.config.name === 'idx_project_sessions_one_available_warm',
    );

    expect(index).toBeDefined();
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column: any) => column.name)).toEqual([
      'project_id',
      'created_by',
    ]);
    expect(index?.config.where).toBeDefined();
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

describe('generated project state tables', () => {
  test('tasks expose durable claim, assignment, dependency, and result fields', () => {
    expect(columnNames(projectTasks)).toEqual([
      'task_id',
      'project_id',
      'goal_slug',
      'parent_id',
      'title',
      'body',
      'status',
      'priority',
      'assignee_agent',
      'assignee_user_id',
      'blocked_by',
      'origin',
      'result',
      'origin_fingerprint',
      'claim_session_id',
      'claimed_at',
      'claim_expires_at',
      'liveness_worker_session_id',
      'liveness_coordinator_session_id',
      'liveness_worker_contract',
      'liveness_started_at',
      'liveness_deadline_at',
      'liveness_iterations_admitted',
      'liveness_turn_id',
      'liveness_admission_id',
      'liveness_admission_expires_at',
      'git_write_request_id',
      'git_write_lease_expires_at',
      'git_write_state',
      'git_write_ref',
      'git_write_old_oid',
      'git_write_new_oid',
      'liveness_last_swept_at',
      'no_progress_settlements',
      'continuation_consumed_at',
      'last_progress_at',
      'last_progress_ref',
      'last_no_progress_settlement_id',
      'last_no_progress_action',
      'last_no_progress_command_id',
      'escalated_at',
      'liveness_blocker',
      'created_at',
      'updated_at',
    ]);
    expect(indexNames(projectTasks)).toContain('idx_project_tasks_project_origin_fingerprint');
    expect(indexNames(projectTasks)).toContain('idx_project_tasks_blocked_by');
    expect(indexNames(projectTasks)).toContain('idx_project_tasks_liveness_deadline');
    expect(indexNames(projectTasks)).toContain('idx_project_tasks_liveness_worker');
    expect(indexNames(projectTasks)).toContain('idx_project_tasks_liveness_sweep');
    expect(indexNames(projectTasks)).toContain('idx_project_tasks_git_write_reconcile');
    expect(indexNames(projectTasks)).toContain('idx_project_tasks_active_claim_session');
    expect(indexNames(projectTasks)).toContain('idx_project_tasks_active_liveness_coordinator');
  });

  test('task Git write state binds one valid command to a doing worker', () => {
    const checks = getTableConfig(projectTasks).checks;
    const names = checks.map((candidate) => candidate.name);
    expect(names).toContain('project_tasks_git_write_complete');
    expect(names).toContain('project_tasks_git_write_state_valid');
    expect(names).toContain('project_tasks_git_write_ref_valid');
    expect(names).toContain('project_tasks_git_write_oid_valid');
    expect(names).toContain('project_tasks_git_write_requires_doing_worker');
    const complete = checks.find(
      (candidate) => candidate.name === 'project_tasks_git_write_complete',
    );
    expect(complete).toBeDefined();
    if (!complete) {
      throw new Error('missing project_tasks_git_write_complete');
    }
    expect(new PgDialect().sqlToQuery(complete.value).sql).toContain('in (0, 2, 6)');
    const worker = checks.find(
      (candidate) => candidate.name === 'project_tasks_git_write_requires_doing_worker',
    );
    const sql = new PgDialect().sqlToQuery(worker!.value).sql;
    expect(sql).toContain(`= 'doing'`);
    expect(sql).toContain('liveness_worker_session_id');
    expect(sql).toContain('liveness_deadline_at');
  });

  test('terminal tasks cannot retain gateway or Git request fences', () => {
    const terminalFence = getTableConfig(projectTasks).checks.find(
      (candidate) => candidate.name === 'project_tasks_terminal_has_no_live_fences',
    );
    expect(terminalFence).toBeDefined();
    const sql = new PgDialect().sqlToQuery(terminalFence!.value).sql;
    expect(sql).toContain(`not in ('done', 'blocked')`);
    expect(sql).toContain('liveness_admission_id');
    expect(sql).toContain('git_write_request_id');
    expect(sql).toContain('git_write_state');
    const turnFence = getTableConfig(projectTasks).checks.find(
      (candidate) => candidate.name === 'project_tasks_turn_requires_doing_worker',
    );
    expect(turnFence).toBeDefined();
    const turnSql = new PgDialect().sqlToQuery(turnFence!.value).sql;
    expect(turnSql).toContain('liveness_turn_id');
    expect(turnSql).toContain(`status" = 'doing'`);
  });

  test('worker contracts cannot exceed server-owned platform ceilings', () => {
    expect(TASK_WORKER_PLATFORM_CEILINGS).toEqual({
      max_wall_seconds: 3_600,
      max_tokens: 1_000_000,
      max_cost_usd: 25,
      max_iterations: 128,
    });

    const ceiling = getTableConfig(projectTasks).checks.find(
      (candidate) => candidate.name === 'project_tasks_liveness_contract_platform_ceiling',
    );
    expect(ceiling).toBeDefined();
    const sql = new PgDialect().sqlToQuery(ceiling!.value).sql;
    expect(sql).toContain(`->>'max_wall_seconds')::numeric <= 3600`);
    expect(sql).toContain(`->>'max_tokens')::numeric <= 1000000`);
    expect(sql).toContain(`->>'max_cost_usd')::numeric <= 25`);
    expect(sql).toContain(`->>'max_iterations')::numeric <= 128`);
  });

  test('no-progress settlements durably key every original result by task and settlement', () => {
    expect(columnNames(projectTaskNoProgressSettlements)).toEqual([
      'project_id',
      'task_id',
      'settlement_id',
      'claim_session_id',
      'worker_session_id',
      'action',
      'command_id',
      'task_snapshot',
      'measured_usage',
      'created_at',
    ]);
    const config = getTableConfig(projectTaskNoProgressSettlements);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'task_id',
      'settlement_id',
    ]);
    expect(
      config.foreignKeys.some(
        (foreignKey) =>
          foreignKey.getName() === 'project_task_no_progress_settlements_task_fkey' &&
          foreignKey.onDelete === 'cascade',
      ),
    ).toBe(true);
  });

  test('worker turns expose one shared progress or no-progress identity', () => {
    expect(columnNames(projectTaskTurnOutcomes)).toEqual([
      'project_id',
      'task_id',
      'settlement_id',
      'claim_session_id',
      'worker_session_id',
      'outcome',
      'task_snapshot',
      'created_at',
    ]);
    const config = getTableConfig(projectTaskTurnOutcomes);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'task_id',
      'settlement_id',
    ]);
  });

  test('goal evaluations and observations expose durable push identity', () => {
    expect(columnNames(projectGoalEvaluations)).toEqual([
      'evaluation_id',
      'project_id',
      'goal_slug',
      'trigger_slug',
      'source',
      'idempotency_key',
      'state',
      'fired_at',
      'lifecycle_command_id',
      'session_id',
      'created_at',
      'updated_at',
    ]);
    expect(indexNames(projectGoalEvaluations)).toContain(
      'idx_project_goal_evaluations_goal_created',
    );
    expect(indexNames(projectGoalEvaluations)).toContain('idx_project_goal_evaluations_goal_fired');
    expect(columnNames(projectGoalObservations)).toEqual([
      'observation_id',
      'project_id',
      'goal_slug',
      'evaluation_id',
      'metric',
      'value',
      'source',
      'session_id',
      'observed_at',
      'created_at',
    ]);
    expect(indexNames(projectGoalObservations)).toContain('idx_project_goal_observations_range');
    expect(indexNames(projectGoalObservations)).toContain(
      'idx_project_goal_observations_evaluation',
    );
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

describe('usage_events idempotency', () => {
  test('stores a nullable key with one unique per-account index', () => {
    const config = getTableConfig(usageEvents);
    expect(config.columns.find((column) => column.name === 'idempotency_key')?.notNull).toBe(false);
    const index = config.indexes.find(
      (candidate) => candidate.config.name === 'idx_usage_events_account_idempotency',
    );
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column: any) => column.name)).toEqual([
      'account_id',
      'idempotency_key',
    ]);
    expect(index?.config.where).toBeDefined();
  });
});
