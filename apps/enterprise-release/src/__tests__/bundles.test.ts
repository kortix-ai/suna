import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SUPABASE_IMAGE_DIGESTS,
  SUPABASE_UPSTREAM_COMMIT,
} from '../../../cli/src/self-host/compose-assets.ts';
import { APPLIANCE_CADDY_IMAGE } from '../../../enterprise-updater/src/caddy.ts';
import {
  materializeAppBundle,
  materializeSupabaseBundle,
  type AppBundleDescriptor,
  type SupabaseBundleDescriptor,
} from '../bundles.ts';

const APP_DIGESTS = {
  api: `sha256:${'a'.repeat(64)}`,
  frontend: `sha256:${'b'.repeat(64)}`,
  gateway: `sha256:${'c'.repeat(64)}`,
};

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
        },
        image_digests: { ...SUPABASE_IMAGE_DIGESTS },
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
      expect(overlay).toContain('supavisor:\n    ulimits:\n      nofile:\n        soft: 100000\n        hard: 100000');
      expect(overlay).not.toMatch(/wal|pitr|base.?backup|archive_command|checkpoint/i);

      for (const script of ['install', 'supabase-start', 'supabase-stop']) {
        const path = join(root, 'bin', script);
        expect(statSync(path).mode & 0o777, script).toBe(0o755);
        const syntax = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
        expect(syntax.status, `${script}: ${syntax.stderr}`).toBe(0);
      }
      for (const script of ['wal-archive', 'base-backup', 'pitr-restore']) {
        expect(existsSync(join(root, 'bin', script)), script).toBe(false);
      }
      const installer = readFileSync(join(root, 'bin', 'install'), 'utf8');
      expect(installer).toContain('aws secretsmanager get-secret-value');
      // The Supabase bundle reads runtime keys from Secrets Manager (AWS) OR a
      // local runtime-env JSON file (the VPS bootstrap path — one self-host system).
      expect(installer).toContain('--runtime-env');
      expect(installer).toContain('secret_json=$(cat "$runtime_env")');
      expect(installer).toContain('/var/lib/kortix/postgres');
      expect(installer).toContain('/var/lib/kortix/storage');
      expect(installer).toContain('docker compose');
      expect(installer).toContain('Compose images do not match the signed immutable image lock');
      expect(installer).not.toContain('kortix-api');
      expect(installer).not.toMatch(/wal|pitr|base.?backup/i);

      const start = readFileSync(join(root, 'bin', 'supabase-start'), 'utf8');
      expect(start).toContain('docker inspect supabase-kong');
      expect(start).toContain('--header "apikey: $anon_key"');
      expect(start).not.toMatch(/wal|pitr|base.?backup/i);
      const stop = readFileSync(join(root, 'bin', 'supabase-stop'), 'utf8');
      expect(stop).not.toMatch(/wal|pitr|base.?backup/i);
      expect(existsSync(join(root, 'systemd'))).toBe(false);
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

  test('materializes a signed, digest-pinned, self-healing app bundle (100% Docker, no ECS)', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-app-bundle-'));
    try {
      const descriptor = materializeAppBundle(root, '0.9.84-e1', APP_DIGESTS);
      expect(descriptor).toEqual({
        schema_version: 1,
        kind: 'kortix-enterprise-app',
        version: '0.9.84-e1',
        compose_files: ['docker-compose.yml'],
        persistent_paths: { caddy: '/var/lib/kortix/caddy' },
        image_digests: { api: APP_DIGESTS.api, frontend: APP_DIGESTS.frontend, gateway: APP_DIGESTS.gateway },
        required_services: ['api', 'caddy', 'frontend', 'gateway'],
      } satisfies AppBundleDescriptor);
      expect(JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8'))).toEqual(descriptor);

      const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
      // 100% Docker: nothing ECS/Fargate anywhere in the generated bundle.
      const allText = [
        compose,
        readFileSync(join(root, 'Caddyfile'), 'utf8'),
        readFileSync(join(root, 'bin', 'install'), 'utf8'),
        readFileSync(join(root, 'bin', 'app-start'), 'utf8'),
        readFileSync(join(root, 'bin', 'watchdog'), 'utf8'),
      ].join('\n');
      expect(allText).not.toMatch(/ecs|fargate|task-definition|register-task|run-task|update-service/i);

      // Self-healing: every service has restart: always AND a real healthcheck AND bounded logs.
      for (const service of ['caddy', 'api', 'gateway', 'frontend']) {
        expect(compose).toContain(`${service}:`);
      }
      expect(compose.match(/restart: always/g)?.length).toBe(4); // caddy, api, gateway, frontend
      expect(compose.match(/healthcheck:/g)?.length).toBe(4);
      expect(compose.match(/driver: json-file/g)?.length).toBe(5); // + migrate
      expect(compose).toContain('max-size: "10m"');
      expect(compose).toContain('max-file: "5"');
      // Caddy must receive the Kong origin, or the Supabase data-plane proxy has
      // no upstream (503) — the Caddyfile reads {$KORTIX_SUPABASE_KONG_ORIGIN}
      // from the container environment.
      expect(compose).toContain('KORTIX_SUPABASE_KONG_ORIGIN: ${KORTIX_SUPABASE_KONG_ORIGIN}');
      // The rendered .env must never leave KORTIX_ACME_EMAIL empty, or Caddy's
      // global `email` directive crash-loops at config parse.
      const installScript = readFileSync(join(root, 'bin', 'install'), 'utf8');
      expect(installScript).toContain('if $acme_email == "" then "admin@" + $frontend_domain else $acme_email end');
      // api runs 2 replicas.
      expect(compose).toMatch(/api:[\s\S]*?replicas: 2/);
      // Images are env-substituted; the install script enforces the digest lock.
      expect(compose).toContain('image: ${KORTIX_API_IMAGE}');
      // Caddy is a fixed appliance dependency: pinned by digest as the compose
      // default so a missing KORTIX_CADDY_IMAGE is never fatal (single source of
      // truth = the updater's APPLIANCE_CADDY_IMAGE).
      expect(compose).toContain(`image: \${KORTIX_CADDY_IMAGE:-${APPLIANCE_CADDY_IMAGE}}`);
      expect(APPLIANCE_CADDY_IMAGE).toMatch(/^docker\.io\/library\/caddy:[\d.]+@sha256:[a-f0-9]{64}$/);
      expect(compose).not.toMatch(/image:\s*supabase\//);

      // Opt-in Route53 DNS-01 Caddy build ships in the bundle (default is stock caddy).
      const caddyDockerfile = readFileSync(join(root, 'caddy', 'Dockerfile'), 'utf8');
      expect(caddyDockerfile).toContain('xcaddy build');
      expect(caddyDockerfile).toContain('github.com/caddy-dns/route53');

      // Caddy load-balances ALL api replicas via Docker DNS with passive health.
      const caddyfile = readFileSync(join(root, 'Caddyfile'), 'utf8');
      expect(caddyfile).toContain('dynamic a');
      expect(caddyfile).toContain('name api');
      expect(caddyfile).toContain('fail_duration');
      expect(caddyfile).toContain('lb_policy round_robin');
      expect(caddyfile).toContain('/v1/llm*');
      expect(caddyfile).toContain('reverse_proxy gateway:8090');
      expect(caddyfile).toContain('reverse_proxy frontend:3000');
      expect(caddyfile).toContain('/rest/v1* /auth/v1* /storage/v1* /realtime/v1* /functions/v1* /graphql/v1*');
      expect(caddyfile).toContain('import /etc/caddy/acme.caddy');

      // Scripts are executable + bash-valid.
      for (const script of ['install', 'app-start', 'app-stop', 'watchdog', 'prune']) {
        const path = join(root, 'bin', script);
        expect(statSync(path).mode & 0o777, script).toBe(0o755);
        const syntax = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
        expect(syntax.status, `${script}: ${syntax.stderr}`).toBe(0);
      }
      const installer = readFileSync(join(root, 'bin', 'install'), 'utf8');
      expect(installer).toContain('kortix-enterprise-app');
      expect(installer).toContain('does not match the signed digest');
      expect(installer).toContain('acme_dns route53');

      // Watchdog respects the updater flock and restarts kortix-app after N failures.
      const watchdog = readFileSync(join(root, 'bin', 'watchdog'), 'utf8');
      expect(watchdog).toContain('/var/lib/kortix/updater.lock');
      expect(watchdog).toContain('flock -n 9 || exit 0');
      expect(watchdog).toContain('systemctl restart kortix-app.service');
      expect(watchdog).toContain('THRESHOLD=3');
      expect(watchdog).toContain('COOLDOWN=600');
      const prune = readFileSync(join(root, 'bin', 'prune'), 'utf8');
      expect(prune).toContain('flock -n 9 || exit 0');
      expect(prune).toContain('docker image prune');

      // systemd units: self-healing restart + Persistent timers.
      const appUnit = readFileSync(join(root, 'systemd', 'kortix-app.service'), 'utf8');
      expect(appUnit).toContain('Restart=on-failure');
      expect(appUnit).toContain('RestartSec=');
      const updaterTimer = readFileSync(join(root, 'systemd', 'kortix-updater.timer'), 'utf8');
      expect(updaterTimer).toContain('Persistent=true');
      const watchdogTimer = readFileSync(join(root, 'systemd', 'kortix-watchdog.timer'), 'utf8');
      expect(watchdogTimer).toContain('OnUnitActiveSec=2min');
      expect(existsSync(join(root, 'systemd', 'kortix-prune.timer'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses app bundle image digests that are not sha256-pinned', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-app-bundle-invalid-'));
    try {
      expect(() => materializeAppBundle(root, '0.9.84-e1', { ...APP_DIGESTS, api: 'latest' }))
        .toThrow('app bundle api image digest must be sha256');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
