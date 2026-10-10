import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_AUDIT_POOL_MAX,
  DEFAULT_DB_POOL_MAX,
  LEADER_ELECTION_POOL_MAX,
  PG_BROADCAST_POOL_MAX,
  PROD_API_MAX_TASKS,
  PROD_DB_NON_API_RESERVE,
  PROD_DB_ROLLING_CONNECTION_CEILING,
  PROD_DB_USABLE_CONNECTIONS,
  ROLLING_TASK_OVERLAP,
} from './database-capacity';

describe('production database connection capacity', () => {
  test('pins every API-owned connection pool in the rollout budget', () => {
    expect(DEFAULT_DB_POOL_MAX).toBe(6);
    expect(DEFAULT_AUDIT_POOL_MAX).toBe(2);
    expect(LEADER_ELECTION_POOL_MAX).toBe(1);
    expect(PG_BROADCAST_POOL_MAX).toBe(1);
  });

  test('keeps the boot schema probe on the shared request pool', () => {
    // The deployed-env drift probe used to open its own transient postgres
    // client at boot, which the rolling-deployment ceiling had to count at
    // one extra connection per starting task (KRTX-2020). It must query
    // through the request pool instead — zero marginal connections.
    const ensureSchema = readFileSync(new URL('../ensure-schema.ts', import.meta.url), 'utf8');
    expect(ensureSchema).not.toMatch(/postgres\(/);
    expect(ensureSchema).toContain("import { db } from './shared/db'");
  });

  test('keeps high-volume audit writers on the bounded audit pool', () => {
    const auditDb = readFileSync(new URL('./audit-db.ts', import.meta.url), 'utf8');
    expect(auditDb).toContain("import { DEFAULT_AUDIT_POOL_MAX } from './database-capacity'");
    expect(auditDb).toContain("intFromEnv('DB_AUDIT_POOL_MAX', DEFAULT_AUDIT_POOL_MAX)");

    for (const relativePath of [
      '../projects/routes/project-audit.ts',
      './audit.ts',
      './gateway-logs.ts',
    ]) {
      const writer = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(writer).toContain('auditDb()');
    }
  });

  test('keeps the base-move LISTEN/NOTIFY connection on the bounded broadcast pool', () => {
    // apps/api/src/bootstrap.ts awaits startConfigBaseMoveBroadcast() on EVERY
    // replica at boot (not leader-gated), and the listener is never released:
    // this is a long-lived, per-task connection exactly like the leader-election
    // one, and the rolling-deployment ceiling must count it the same way.
    const pgBroadcast = readFileSync(new URL('./pg-broadcast.ts', import.meta.url), 'utf8');
    expect(pgBroadcast).toContain("import { PG_BROADCAST_POOL_MAX } from './database-capacity'");
    expect(pgBroadcast).toContain('max: PG_BROADCAST_POOL_MAX');

    // The boot wiring moved into bootstrap.ts (KRTX-347 split).
    const boot = readFileSync(new URL('../bootstrap.ts', import.meta.url), 'utf8');
    expect(boot).toContain('startConfigBaseMoveBroadcast');
  });

  test('keeps a maximum rolling deployment below the usable PostgreSQL limit', () => {
    // Prod sets deployment_maximum_percent = 100 (one extra task, see the
    // Terraform cross-check below), so the envelope overlaps one task, not two.
    expect(PROD_API_MAX_TASKS).toBe(10);
    expect(ROLLING_TASK_OVERLAP).toBe(1);
    expect(PROD_DB_USABLE_CONNECTIONS).toBe(237);
    expect(PROD_DB_NON_API_RESERVE).toBe(32);
    // Recomputed from the pins above, not trusted: the exported ceiling must
    // equal tasks × overlap × per-task long-lived pools. The boot schema probe
    // is no longer a term — it rides the request pool.
    const perTaskPools =
      DEFAULT_DB_POOL_MAX + DEFAULT_AUDIT_POOL_MAX + LEADER_ELECTION_POOL_MAX + PG_BROADCAST_POOL_MAX;
    expect(PROD_DB_ROLLING_CONNECTION_CEILING).toBe(
      PROD_API_MAX_TASKS * ROLLING_TASK_OVERLAP * perTaskPools,
    );
    expect(PROD_DB_ROLLING_CONNECTION_CEILING).toBe(100);
    expect(PROD_DB_ROLLING_CONNECTION_CEILING).toBeLessThanOrEqual(
      PROD_DB_USABLE_CONNECTIONS - PROD_DB_NON_API_RESERVE,
    );
  });

  test('matches the production ECS capacity and deployment overlap', () => {
    const productionTerraform = readFileSync(
      new URL('../../../../infra/terraform/environments/prod/main.tf', import.meta.url),
      'utf8',
    );
    const shadowTerraform = readFileSync(
      new URL('../../../../infra/terraform/environments/prod-us-east-2-shadow/main.tf', import.meta.url),
      'utf8',
    );
    const ecsModule = readFileSync(
      new URL('../../../../infra/terraform/modules/ecs-api/main.tf', import.meta.url),
      'utf8',
    );
    const ecsModuleVariables = readFileSync(
      new URL('../../../../infra/terraform/modules/ecs-api/variables.tf', import.meta.url),
      'utf8',
    );

    expect(productionTerraform).toMatch(/module "api"[\s\S]*?max_capacity\s*=\s*10/);

    // The module keeps the old 200% as its default (dev and staging are
    // unchanged); prod pins 100% on BOTH prod API stacks: one extra task at
    // the rolling peak instead of ten. The us-east-2 shadow serves the same
    // database budget, so its fleet must honor the same pin.
    expect(ecsModuleVariables).toMatch(/variable "deployment_maximum_percent"[\s\S]*?default\s*=\s*200/);
    expect(ecsModule).toMatch(/deployment_maximum_percent\s*=\s*var\.deployment_maximum_percent/);
    expect(productionTerraform).toMatch(/module "api"[\s\S]*?deployment_maximum_percent\s*=\s*100/);
    expect(shadowTerraform).toMatch(/module "api"[\s\S]*?deployment_maximum_percent\s*=\s*100/);
  });
});
