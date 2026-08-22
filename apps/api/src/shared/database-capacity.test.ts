import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_AUDIT_POOL_MAX,
  DEFAULT_DB_POOL_MAX,
  LEADER_ELECTION_POOL_MAX,
  PROD_API_MAX_TASKS,
  PROD_DB_NON_API_RESERVE,
  PROD_DB_ROLLING_CONNECTION_CEILING,
  PROD_DB_USABLE_CONNECTIONS,
  ROLLING_TASK_OVERLAP,
  SCHEMA_CHECK_POOL_MAX,
} from './database-capacity';

describe('production database connection capacity', () => {
  test('pins every API-owned connection pool in the rollout budget', () => {
    expect(DEFAULT_DB_POOL_MAX).toBe(6);
    expect(DEFAULT_AUDIT_POOL_MAX).toBe(2);
    expect(LEADER_ELECTION_POOL_MAX).toBe(1);
    expect(SCHEMA_CHECK_POOL_MAX).toBe(1);
  });

  test('keeps a maximum rolling deployment below the usable PostgreSQL limit', () => {
    expect(PROD_API_MAX_TASKS).toBe(10);
    expect(ROLLING_TASK_OVERLAP).toBe(2);
    expect(PROD_DB_USABLE_CONNECTIONS).toBe(237);
    expect(PROD_DB_NON_API_RESERVE).toBe(32);
    expect(PROD_DB_ROLLING_CONNECTION_CEILING).toBe(190);
    expect(PROD_DB_ROLLING_CONNECTION_CEILING).toBeLessThanOrEqual(
      PROD_DB_USABLE_CONNECTIONS - PROD_DB_NON_API_RESERVE,
    );
  });

  test('matches the production ECS capacity and deployment overlap', () => {
    const productionTerraform = readFileSync(
      new URL('../../../../infra/terraform/environments/prod/main.tf', import.meta.url),
      'utf8',
    );
    const ecsModule = readFileSync(
      new URL('../../../../infra/terraform/modules/ecs-api/main.tf', import.meta.url),
      'utf8',
    );

    expect(productionTerraform).toMatch(/module "api"[\s\S]*?max_capacity\s*=\s*10/);
    expect(ecsModule).toMatch(/deployment_maximum_percent\s*=\s*200/);
  });
});
