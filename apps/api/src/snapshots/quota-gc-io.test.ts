import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUOTA_GC_ORG_TARGET } from './quota-gc-select';
import {
  dataPlaneScopeFromSupabaseUrl,
  scopedPerProjectWarmImageName,
} from './ppwarm-names';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const MODULE_URL = pathToFileURL(join(import.meta.dir, 'quota-gc.ts')).href;
const RESULT_MARKER = '__KORTIX_QUOTA_GC_RESULT__';
const NOW = Date.parse('2026-08-21T00:00:00Z');
const OLD = new Date(NOW - 30 * 86400000).toISOString();
const OWNED_SCOPE = dataPlaneScopeFromSupabaseUrl('http://127.0.0.1:54321', 'dev');
const FOREIGN_SCOPE = dataPlaneScopeFromSupabaseUrl('http://127.0.0.1:54321', 'staging');

interface OperationInput {
  configured?: boolean;
  failure?: 'list' | 'referenced' | 'pins';
  snapshots: Array<{
    id: string;
    name: string;
    state: string;
    createdAt: string;
    lastUsedAt: string;
  }>;
}

interface OperationResult {
  deleteCalls: string[];
  result: {
    allowed?: boolean;
    reason?: string;
    quota?: {
      observationStatus: string;
      orgTotal: number;
      deferred: number;
      budgetUnresolved: boolean;
      deleted: number;
    };
    observationStatus?: string;
    orgTotal?: number;
    deferred?: number;
    budgetUnresolved?: boolean;
    deleted?: number;
  };
}

function runQuotaGc(script: string): unknown {
  const output = execFileSync('bun', ['--eval', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54322/postgres',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
      API_KEY_SECRET: 'test-api-key-secret',
      TUNNEL_SIGNING_SECRET: 'test-tunnel-signing-secret',
      ALLOWED_SANDBOX_PROVIDERS: 'daytona',
      DAYTONA_API_KEY: 'test-daytona-key',
      DAYTONA_SERVER_URL: 'https://daytona.example.test',
      DAYTONA_TARGET: 'test-target',
      FRONTEND_URL: 'http://localhost:3000',
      INTERNAL_KORTIX_ENV: 'dev',
    },
  });
  const marker = output.lastIndexOf(RESULT_MARKER);
  if (marker < 0) throw new Error(`quota GC subprocess returned no result: ${output}`);
  return JSON.parse(output.slice(marker + RESULT_MARKER.length));
}

function runOperation(kind: 'assess' | 'reconcile', input: OperationInput): OperationResult {
  return runQuotaGc(`
    const quota = await import(${JSON.stringify(MODULE_URL)});
    const input = ${JSON.stringify(input)};
    const deleteCalls = [];
    const io = {
      isConfigured: () => input.configured !== false,
      listSnapshots: async () => {
        if (input.failure === 'list') throw new Error('org list unavailable');
        return input.snapshots;
      },
      loadReferencedSnapshotNames: async () => {
        if (input.failure === 'referenced') throw new Error('reference database unavailable');
        return new Set();
      },
      loadPinnedImageRefs: async () => {
        if (input.failure === 'pins') throw new Error('pin database unavailable');
        return new Set();
      },
      deleteSnapshotById: async (id) => { deleteCalls.push(id); return true; },
    };
    const result = ${kind === 'assess'
      ? 'await quota.assessDaytonaProjectImageAdmission({ now: ' + NOW + ' }, io)'
      : 'await quota.reconcileSnapshotQuota({ now: ' + NOW + ' }, io)'};
    process.stdout.write(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ deleteCalls, result }));
  `) as OperationResult;
}

function stockSnapshots(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    id: `stock-${index}`,
    name: `daytonaio/stock-${index}`,
    state: 'active',
    createdAt: OLD,
    lastUsedAt: OLD,
  }));
}

function brokenManagedSnapshots(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    id: `managed-${index}`,
    name: `kortix-default-broken-${index}`,
    state: 'error',
    createdAt: OLD,
    lastUsedAt: OLD,
  }));
}

describe('assessDaytonaProjectImageAdmission', () => {
  test('allows a complete healthy observation below target without deleting', () => {
    const observed = runOperation('assess', { snapshots: stockSnapshots(83) });

    expect(observed.deleteCalls).toEqual([]);
    expect(observed.result).toMatchObject({
      allowed: true,
      reason: 'allowed',
      quota: {
        observationStatus: 'complete',
        orgTotal: 83,
        deferred: 0,
        budgetUnresolved: false,
      },
    });
  });

  test('never invokes deletion during a dry-run assessment', () => {
    const observed = runOperation('assess', {
      snapshots: [...brokenManagedSnapshots(1), ...stockSnapshots(82)],
    });

    expect(observed.deleteCalls).toEqual([]);
    expect(observed.result).toMatchObject({
      allowed: true,
      reason: 'allowed',
      quota: { observationStatus: 'complete', deleted: 1 },
    });
  });

  test('denies when the org is at the target', () => {
    const observed = runOperation('assess', { snapshots: stockSnapshots(QUOTA_GC_ORG_TARGET) });

    expect(observed.deleteCalls).toEqual([]);
    expect(observed.result).toMatchObject({
      allowed: false,
      reason: 'org_target_reached',
      quota: { observationStatus: 'complete', orgTotal: QUOTA_GC_ORG_TARGET },
    });
  });

  test('denies when the quota budget is unresolved', () => {
    const observed = runOperation('assess', {
      snapshots: stockSnapshots(QUOTA_GC_ORG_TARGET + 1),
    });

    expect(observed.deleteCalls).toEqual([]);
    expect(observed.result).toMatchObject({
      allowed: false,
      reason: 'budget_unresolved',
      quota: { observationStatus: 'complete', budgetUnresolved: true },
    });
  });

  test('denies when safe candidates remain deferred', () => {
    const observed = runOperation('assess', {
      snapshots: [...brokenManagedSnapshots(20), ...stockSnapshots(60)],
    });

    expect(observed.deleteCalls).toEqual([]);
    expect(observed.result).toMatchObject({
      allowed: false,
      reason: 'deferred_candidates',
      quota: { observationStatus: 'complete', deferred: 5 },
    });
  });

  test.each([
    ['list', 'org_list_failed'],
    ['referenced', 'referenced_names_failed'],
    ['pins', 'pin_lookup_failed'],
  ] as const)('denies a %s observation failure', (failure, reason) => {
    const observed = runOperation('assess', {
      failure,
      snapshots: [...brokenManagedSnapshots(1), ...stockSnapshots(79)],
    });

    expect(observed.deleteCalls).toEqual([]);
    expect(observed.result).toMatchObject({
      allowed: false,
      reason,
      quota: { observationStatus: reason },
    });
  });

  test('denies when Daytona is not configured', () => {
    const observed = runOperation('assess', {
      configured: false,
      snapshots: stockSnapshots(1),
    });

    expect(observed.deleteCalls).toEqual([]);
    expect(observed.result).toMatchObject({
      allowed: false,
      reason: 'provider_not_configured',
      quota: { observationStatus: 'provider_not_configured' },
    });
  });
});

describe('reconcileSnapshotQuota observation boundary', () => {
  test('forwards the current data-plane scope and deletes no foreign scoped image', () => {
    const projectId = '0945686d-1111-2222-3333-444455556666';
    const owned = {
      id: 'owned-scoped',
      name: scopedPerProjectWarmImageName(
        OWNED_SCOPE,
        projectId,
        'tip-owned',
        'kortix-default-r1',
        'default',
      ),
      state: 'error',
      createdAt: OLD,
      lastUsedAt: OLD,
    };
    const foreign = {
      ...owned,
      id: 'foreign-scoped',
      name: scopedPerProjectWarmImageName(
        FOREIGN_SCOPE,
        projectId,
        'tip-foreign',
        'kortix-default-r1',
        'default',
      ),
    };
    const observed = runOperation('reconcile', {
      snapshots: [owned, foreign, ...stockSnapshots(78)],
    });

    expect(observed.deleteCalls).toEqual(['owned-scoped']);
    expect(observed.deleteCalls).not.toContain('foreign-scoped');
  });

  test.each([
    ['list', 'org_list_failed'],
    ['referenced', 'referenced_names_failed'],
    ['pins', 'pin_lookup_failed'],
  ] as const)('returns %s failure without deleting', (failure, observationStatus) => {
    const observed = runOperation('reconcile', {
      failure,
      snapshots: [...brokenManagedSnapshots(1), ...stockSnapshots(79)],
    });

    expect(observed.deleteCalls).toEqual([]);
    expect(observed.result).toMatchObject({ observationStatus, deleted: 0 });
  });

  test('preserves deletion for a complete periodic GC observation', () => {
    const observed = runOperation('reconcile', {
      snapshots: [...brokenManagedSnapshots(1), ...stockSnapshots(79)],
    });

    expect(observed.deleteCalls).toEqual(['managed-0']);
    expect(observed.result).toMatchObject({
      observationStatus: 'complete',
      orgTotal: 80,
      deleted: 1,
    });
  });
});
