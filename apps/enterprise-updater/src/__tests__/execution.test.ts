import { describe, expect, test } from 'bun:test';

import {
  isWithinMaintenanceWindow,
  parseUpdateRequest,
  requireFreshRecoveryPoint,
  requireMaintenanceWindow,
  selectRelease,
  type InstalledReleaseState,
} from '../execution.ts';
import { parseEnterpriseReleaseManifest } from '../release-contract.ts';

const HASH = 'a'.repeat(64);
const DIGEST = `sha256:${HASH}`;

function manifest(version = '0.9.84-e1', rollbackFrom = ['0.9.85-e1']) {
  const prod = version.split('-e')[0]!;
  return parseEnterpriseReleaseManifest({
    schema_version: 1,
    version,
    channel: 'stable',
    published_at: '2026-07-13T12:00:00Z',
    prod: { version: prod, source_sha: 'b'.repeat(40) },
    enterprise: { source_sha: 'c'.repeat(40) },
    compatibility: { architectures: ['amd64'], kubernetes_minor: ['1.32'], rollback_from: rollbackFrom },
    images: {
      api: { source: `index.docker.io/kortix/kortix-api@${DIGEST}`, digest: DIGEST, customer_repository: 'api' },
      frontend: { source: `index.docker.io/kortix/kortix-frontend@${DIGEST}`, digest: DIGEST, customer_repository: 'frontend' },
      gateway: { source: `index.docker.io/kortix/kortix-gateway@${DIGEST}`, digest: DIGEST, customer_repository: 'gateway' },
    },
    artifacts: {
      platform_bundle: { target: `releases/${version}/platform.tar.gz`, sha256: HASH, length: 1 },
      supabase_bundle: { target: `releases/${version}/supabase.tar.gz`, sha256: HASH, length: 1 },
      cosign_public_key: { target: 'keys/cosign.pub', sha256: HASH, length: 1 },
      updater_binary: { target: `releases/${version}/updater-linux-amd64`, sha256: HASH, length: 1 },
    },
    migrations: [{ id: 'migration', sha256: HASH, reversible: true, backward_compatible: true }],
    health: { api_path: '/v1/health', frontend_path: '/api/health', expected_version: prod },
  });
}

function state(overrides: Partial<InstalledReleaseState> = {}): InstalledReleaseState {
  return {
    release: '0.9.85-e1',
    channel: 'stable',
    status: 'healthy',
    manifest_sha256: 'c'.repeat(64),
    updated_at: '2026-07-13T12:00:00Z',
    last_wal_archived_at: '2026-07-13T11:55:00Z',
    last_wal_name: '000000010000000000000001',
    last_base_backup_at: '2026-07-13T03:30:00Z',
    last_base_backup_key: 'basebackups/customer/20260713T033000Z/base.tar.gz',
    history: [],
    ...overrides,
  };
}

describe('updater execution contract', () => {
  test('normalizes customer hourly and publisher hint events', () => {
    expect(parseUpdateRequest({ source: 'aws.events', 'detail-type': 'Scheduled Event' }).trigger).toBe('hourly');
    expect(parseUpdateRequest({
      source: 'com.kortix.enterprise.release',
      'detail-type': 'Kortix stable release',
      detail: { channel: 'stable', release: '0.9.84-e1' },
    }).trigger).toBe('release-hint');
  });

  test('rejects rollback targets that were not verified healthy in this customer account', () => {
    const request = parseUpdateRequest({ trigger: 'cli-rollback', rollback_to: '0.9.84-e1' });
    expect(() => selectRelease(request, state(), manifest(), HASH)).toThrow('verified healthy release history');
  });

  test('allows only a compatible digest-identical verified rollback target', () => {
    const request = parseUpdateRequest({ trigger: 'cli-rollback', rollback_to: '0.9.84-e1' });
    const current = state({
      history: [{ release: '0.9.84-e1', manifest_sha256: HASH, verified_at: '2026-07-12T12:00:00Z', status: 'healthy' }],
    });
    expect(selectRelease(request, current, manifest(), HASH)).toEqual({ action: 'rollback', release: '0.9.84-e1' });
  });

  test('uses the signed rollback-from contract rather than the old release migration list', () => {
    const request = parseUpdateRequest({ trigger: 'cli-rollback', rollback_to: '0.9.84-e1' });
    const current = state({
      history: [{ release: '0.9.84-e1', manifest_sha256: HASH, verified_at: '2026-07-12T12:00:00Z', status: 'healthy' }],
    });
    const candidate = manifest();
    candidate.migrations = [{ id: 'baseline', sha256: HASH, reversible: false, backward_compatible: false }];
    expect(selectRelease(request, current, candidate, HASH)).toEqual({ action: 'rollback', release: '0.9.84-e1' });
  });

  test('force bypasses only the maintenance-window gate', () => {
    const outside = new Date('2026-07-13T12:00:00Z');
    const normal = parseUpdateRequest({ trigger: 'cli-update', requested_release: '0.9.84-e1' });
    expect(() => requireMaintenanceWindow(normal, 'Sun:02:00-05:00', outside, true)).toThrow('outside UTC');
    const forced = parseUpdateRequest({ trigger: 'cli-update', requested_release: '0.9.84-e1', force: true });
    expect(() => requireMaintenanceWindow(forced, 'Sun:02:00-05:00', outside, true)).not.toThrow();
  });

  test('supports a maintenance window that crosses UTC midnight', () => {
    expect(isWithinMaintenanceWindow('Sun:23:00-02:00', new Date('2026-07-12T23:30:00Z'))).toBe(true);
    expect(isWithinMaintenanceWindow('Sun:23:00-02:00', new Date('2026-07-13T01:30:00Z'))).toBe(true);
    expect(isWithinMaintenanceWindow('Sun:23:00-02:00', new Date('2026-07-13T02:00:00Z'))).toBe(false);
  });

  test('requires both a recent WAL archive and physical base backup before mutation', () => {
    const now = new Date('2026-07-13T12:00:00Z');
    expect(() => requireFreshRecoveryPoint(state(), now)).not.toThrow();
    expect(() => requireFreshRecoveryPoint(state({ last_wal_archived_at: '2026-07-13T11:30:00Z' }), now))
      .toThrow('WAL archive is not within 15 minutes');
    expect(() => requireFreshRecoveryPoint(state({ last_base_backup_at: null }), now))
      .toThrow('physical base backup freshness is unavailable');
  });
});
