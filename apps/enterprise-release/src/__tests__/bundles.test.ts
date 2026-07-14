import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SUPABASE_IMAGE_DIGESTS,
  SUPABASE_UPSTREAM_COMMIT,
} from '../../../cli/src/self-host/compose-assets.ts';
import {
  materializePlatformBundle,
  materializeSupabaseBundle,
  type PlatformBundleDescriptor,
  type SupabaseBundleDescriptor,
} from '../bundles.ts';

describe('enterprise release bundles', () => {
  test('materializes an authenticated Supabase-only EC2 payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-supabase-bundle-'));
    try {
      const descriptor = materializeSupabaseBundle(root, '0.9.84-e1');
      expect(descriptor).toEqual({
        schema_version: 1,
        kind: 'kortix-enterprise-supabase',
        version: '0.9.84-e1',
        supabase_upstream_commit: SUPABASE_UPSTREAM_COMMIT,
        compose_files: ['docker-compose.yml', 'docker-compose.logs.yml', 'docker-compose.enterprise.yml'],
        persistent_paths: {
          'volumes/db/data': '/var/lib/kortix/postgres',
          'volumes/storage': '/var/lib/kortix/storage',
          wal_spool: '/var/lib/kortix/wal',
          recovery_wal: '/var/lib/kortix/recovery-wal',
        },
        image_digests: { ...SUPABASE_IMAGE_DIGESTS },
        backup: {
          archive_timeout_seconds: 300,
          wal_upload_interval_seconds: 60,
          base_backup_interval: 'daily',
        },
        required_services: [
          'analytics', 'auth', 'db', 'functions', 'imgproxy', 'kong', 'meta',
          'realtime', 'rest', 'storage', 'studio', 'supavisor', 'vector',
        ],
      } satisfies SupabaseBundleDescriptor);
      expect(JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8'))).toEqual(descriptor);

      const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
      expect(compose).not.toContain('kortix-api:');
      expect(compose).not.toContain('frontend:');
      expect(compose).not.toContain('llm-gateway:');
      expect(compose).toMatch(/image: supabase\/postgres:17\.6\.1\.136@sha256:[a-f0-9]{64}/);
      const overlay = readFileSync(join(root, 'docker-compose.enterprise.yml'), 'utf8');
      expect(overlay).toContain('archive_mode=on');
      expect(overlay).toContain('archive_timeout=300s');
      expect(overlay).toContain('/var/lib/kortix/wal:/var/lib/kortix-wal:Z');
      expect(overlay).toContain('/var/lib/kortix/recovery-wal:/var/lib/kortix-recovery-wal:ro,Z');
      expect(overlay).toContain('supavisor:\n    ulimits:\n      nofile:\n        soft: 100000\n        hard: 100000');

      for (const script of ['install', 'supabase-start', 'supabase-stop', 'wal-archive', 'base-backup', 'pitr-restore']) {
        const path = join(root, 'bin', script);
        expect(statSync(path).mode & 0o777, script).toBe(0o755);
        const syntax = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
        expect(syntax.status, `${script}: ${syntax.stderr}`).toBe(0);
      }
      const installer = readFileSync(join(root, 'bin', 'install'), 'utf8');
      expect(installer).toContain('aws secretsmanager get-secret-value');
      expect(installer).toContain('/var/lib/kortix/postgres');
      expect(installer).toContain('/var/lib/kortix/storage');
      expect(installer).toContain('docker compose');
      expect(installer).toContain('Compose images do not match the signed immutable image lock');
      expect(installer).toContain('kortix-wal-archive.timer');
      expect(readFileSync(join(root, 'bin', 'wal-archive'), 'utf8')).toContain('s3api head-object');
      expect(readFileSync(join(root, 'bin', 'base-backup'), 'utf8')).toContain('pg_basebackup');
      expect(installer).not.toContain('kortix-api');

      const start = readFileSync(join(root, 'bin', 'supabase-start'), 'utf8');
      expect(start).toContain('docker inspect supabase-kong');
      expect(start).toContain('--header "apikey: $anon_key"');
      expect(start).toContain('systemctl enable --now kortix-wal-archive.timer kortix-base-backup.timer');
      expect(start).not.toContain('systemctl start kortix-wal-archive.service');
      const walUnit = readFileSync(join(root, 'systemd', 'kortix-wal-archive.service'), 'utf8');
      expect(walUnit).toContain('After=network-online.target kortix-supabase.service');
      const physicalRoot = start.split('\n').find((line) => line.startsWith('root=$(readlink -f '));
      expect(physicalRoot).toBeDefined();
      symlinkSync('.', join(root, 'current'));
      const probe = join(root, 'bin', 'root-probe');
      writeFileSync(probe, `#!/usr/bin/env bash\nset -euo pipefail\n${physicalRoot}\nprintf '%s\\n' "$root"\n`, { mode: 0o755 });
      const resolved = spawnSync(join(root, 'current', 'bin', 'root-probe'), [], { encoding: 'utf8' });
      expect({ status: resolved.status, stderr: resolved.stderr, root: resolved.stdout.trim() })
        .toEqual({ status: 0, stderr: '', root: realpathSync(root) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses non-enterprise bundle versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-supabase-bundle-invalid-'));
    try {
      expect(() => materializeSupabaseBundle(root, 'latest')).toThrow(
        'enterprise bundle version must use <prod-version>-e<revision>',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('materializes the reviewed platform Terraform and digest-aware charts', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-platform-bundle-'));
    try {
      const descriptor = materializePlatformBundle(root, '0.9.84-e1');
      expect(descriptor).toEqual({
        schema_version: 1,
        kind: 'kortix-enterprise-platform',
        version: '0.9.84-e1',
        terraform_root: 'terraform/environments/enterprise-vpc-template/platform',
        charts: {
          api: 'charts/kortix-api',
          gateway: 'charts/kortix-gateway',
          edge: 'charts/kortix-enterprise-edge',
        },
        namespace: 'kortix-app',
        deployments: ['kortix-api', 'kortix-gateway', 'kortix-frontend'],
      } satisfies PlatformBundleDescriptor);
      expect(readFileSync(join(root, descriptor.terraform_root, 'main.tf'), 'utf8'))
        .toContain('module "platform"');
      for (const chart of Object.values(descriptor.charts)) {
        expect(readFileSync(join(root, chart, 'Chart.yaml'), 'utf8')).toContain('apiVersion: v2');
      }
      expect(readFileSync(join(root, descriptor.charts.api, 'templates/_helpers.tpl'), 'utf8'))
        .toContain('@%s');
      expect(readFileSync(join(root, descriptor.charts.edge, 'templates/ingress.yaml'), 'utf8'))
        .toContain('/auth/v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
