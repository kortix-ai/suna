import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

import {
  kortixRuntimeAssets,
  officialSupabaseDockerAssets,
  renderFullDockerCompose,
  SUPABASE_IMAGE_DIGESTS,
  SUPABASE_UPSTREAM_COMMIT,
  supabaseUpstreamDockerAssets,
  supabaseVendorAssets,
  writeKortixRuntimeAssets,
  writeOfficialSupabaseDockerAssets,
  writeSupabaseVendorAssets,
} from '../compose-assets.ts';

describe('full self-host Docker distribution', () => {
  test('renders the complete pinned Supabase and Kortix service set', () => {
    const document = parse(renderFullDockerCompose('kortix-enterprise')) as {
      services: Record<string, {
        image?: string;
        container_name?: string;
        ports?: string[];
        depends_on?: Record<string, unknown>;
        healthcheck?: { test?: string[] };
      }>;
    };

    expect(Object.keys(document.services).sort()).toEqual([
      'frontend',
      'kortix-api',
      'kortix-migrate',
      'kortix-updater',
      'llm-gateway',
      'supabase-analytics',
      'supabase-auth',
      'supabase-db',
      'supabase-functions',
      'supabase-imgproxy',
      'supabase-kong',
      'supabase-meta',
      'supabase-realtime',
      'supabase-rest',
      'supabase-storage',
      'supabase-studio',
      'supabase-supavisor',
      'supabase-vector',
    ]);
    expect(document.services['supabase-db']?.image).toBe(`supabase/postgres:17.6.1.136@${SUPABASE_IMAGE_DIGESTS['supabase/postgres:17.6.1.136']}`);
    expect(document.services['supabase-studio']?.image).toBe(`supabase/studio:2026.07.07-sha-a6a04f2@${SUPABASE_IMAGE_DIGESTS['supabase/studio:2026.07.07-sha-a6a04f2']}`);
    expect(document.services['supabase-analytics']?.image).toBe(`supabase/logflare:1.43.1@${SUPABASE_IMAGE_DIGESTS['supabase/logflare:1.43.1']}`);
    expect(document.services['supabase-db']?.healthcheck?.test).toEqual([
      'CMD-SHELL',
      'tr \'\\0\' \' \' </proc/1/cmdline | grep -q \'/postgres \' && PGPASSWORD="$${POSTGRES_PASSWORD}" psql -h supabase-db -U supabase_auth_admin -d "$${POSTGRES_DB}" -tAc \'select 1\' >/dev/null',
    ]);

    for (const [name, service] of Object.entries(document.services)) {
      expect(service.container_name, `${name} must support multiple Kortix instances`).toBeUndefined();
      if (service.image && !service.image.startsWith('${')) {
        if (name.startsWith('supabase-')) {
          expect(service.image, `${name} image must be immutable`).toMatch(/@sha256:[a-f0-9]{64}$/);
        } else {
          expect(service.image, `${name} image must not use latest`).not.toEndWith(':latest');
        }
      }
      for (const port of service.ports ?? []) {
        expect(port, `${name} must bind only on loopback`).toStartWith('127.0.0.1:');
      }
      for (const dependency of Object.keys(service.depends_on ?? {})) {
        expect(document.services[dependency], `${name} depends on missing ${dependency}`).toBeDefined();
      }
    }
  });

  test('omits the caddy reverse-proxy service when no domain is configured', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, unknown>;
    };
    expect(document.services).not.toHaveProperty('caddy');
  });

  test('includes the caddy reverse-proxy service only when a domain is configured', () => {
    const document = parse(renderFullDockerCompose('kortix-default', { domainConfigured: true })) as {
      services: Record<string, {
        image?: string;
        ports?: string[];
        environment?: Record<string, string>;
        healthcheck?: { test?: string[] };
      }>;
    };
    const caddy = document.services.caddy;
    expect(caddy).toBeDefined();
    expect(caddy?.ports).toEqual(['80:80', '443:443']);
    expect(caddy?.environment).toMatchObject({
      KORTIX_DOMAIN: '${KORTIX_DOMAIN}',
      KORTIX_API_DOMAIN: '${KORTIX_API_DOMAIN}',
    });
  });

  test('prod (domain-configured) mode: 2 replicas + no host ports for api/gateway/frontend, Caddy present', () => {
    const document = parse(renderFullDockerCompose('kortix-default', { domainConfigured: true })) as {
      services: Record<string, { ports?: string[]; deploy?: { replicas?: number } }>;
    };
    for (const name of ['kortix-api', 'llm-gateway', 'frontend'] as const) {
      const service = document.services[name];
      expect(service, name).toBeDefined();
      expect(service?.deploy?.replicas, `${name} replicas`).toBe(2);
      expect(service?.ports, `${name} must publish no host port in prod mode`).toBeUndefined();
    }
    expect(document.services.caddy).toBeDefined();
  });

  test('laptop (no domain) mode: single replica + loopback host ports for api/gateway/frontend, no Caddy', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { ports?: string[]; deploy?: { replicas?: number } }>;
    };
    const api = document.services['kortix-api'];
    const frontend = document.services.frontend;
    const gateway = document.services['llm-gateway'];
    expect(api?.deploy?.replicas).toBe(1);
    expect(frontend?.deploy?.replicas).toBe(1);
    expect(gateway?.deploy?.replicas).toBe(1);
    expect(api?.ports?.[0]).toStartWith('127.0.0.1:');
    expect(frontend?.ports?.[0]).toStartWith('127.0.0.1:');
    // llm-gateway is never reached directly by a client in either mode.
    expect(gateway?.ports).toBeUndefined();
    expect(document.services).not.toHaveProperty('caddy');
  });

  test('the kortix-updater service is always present and mounts the docker socket', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { volumes?: string[]; environment?: Record<string, string> }>;
    };
    const updater = document.services['kortix-updater'];
    expect(updater).toBeDefined();
    expect(updater?.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(updater?.environment).toHaveProperty('KORTIX_AUTO_UPDATE');
    expect(updater?.environment).toHaveProperty('KORTIX_UPDATE_TIME');
    expect(updater?.environment).toHaveProperty('KORTIX_UPDATE_TZ');
    expect(updater?.environment).toHaveProperty('KORTIX_ALLOW_DOWNTIME');
    expect(updater?.environment).toHaveProperty('KORTIX_APP_REPLICAS');
  });

  test('app service healthchecks probe the correct path with a runtime present in the image', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { healthcheck?: { test?: string[] } }>;
    };
    const apiTest = document.services['kortix-api']?.healthcheck?.test?.join(' ') ?? '';
    expect(apiTest).toContain('bun');
    expect(apiTest).toContain('/v1/health');

    const gatewayTest = document.services['llm-gateway']?.healthcheck?.test?.join(' ') ?? '';
    expect(gatewayTest).toContain('bun');
    expect(gatewayTest).toContain('localhost:8090/health');

    const frontendTest = document.services.frontend?.healthcheck?.test?.join(' ') ?? '';
    expect(frontendTest).toContain('node');
    expect(frontendTest).not.toContain('bun');
  });

  test('embeds the Caddyfile and updater script as runtime assets', () => {
    expect(Object.keys(kortixRuntimeAssets).sort()).toEqual(['Caddyfile', 'updater.sh']);
    expect(kortixRuntimeAssets.Caddyfile).toContain('{$KORTIX_DOMAIN}');
    expect(kortixRuntimeAssets.Caddyfile).toContain('{$KORTIX_API_DOMAIN}');
    expect(kortixRuntimeAssets['updater.sh']).toContain('docker compose');
    expect(kortixRuntimeAssets['updater.sh']).toContain('flock');
  });

  test('Caddyfile load-balances every replicated service with dynamic a + active health checks', () => {
    const caddyfile = kortixRuntimeAssets.Caddyfile;
    for (const [name, port, healthPath] of [
      ['kortix-api', '8008', '/v1/health'],
      ['llm-gateway', '8090', '/health'],
      ['frontend', '3000', '/'],
    ] as const) {
      expect(caddyfile, name).toContain(`name ${name}`);
      expect(caddyfile, name).toContain(`port ${port}`);
      expect(caddyfile, name).toContain(`health_uri ${healthPath}`);
    }
    expect(caddyfile).toContain('dynamic a');
    expect(caddyfile).toContain('fail_duration');
  });

  test('updater.sh implements the start-first rollout: scale up new before stopping old', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    const rollFn = script.slice(script.indexOf('roll_service()'), script.indexOf('recreate_service()'));
    expect(rollFn).toContain('--no-recreate');
    expect(rollFn).toContain('--scale');

    const scaleUpIdx = rollFn.indexOf('$COMPOSE up -d --no-deps --no-recreate --scale');
    const waitHealthyIdx = rollFn.indexOf('wait_healthy');
    const removeOldIdx = rollFn.indexOf('remove_containers $old_ids');
    expect(scaleUpIdx).toBeGreaterThan(-1);
    expect(waitHealthyIdx).toBeGreaterThan(scaleUpIdx);
    expect(removeOldIdx).toBeGreaterThan(waitHealthyIdx);
  });

  test('updater.sh runs migrations before any service is rolled (migrate-before-swap)', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    const perform = script.slice(script.indexOf('perform_update()'), script.indexOf('next_run_epoch()'));
    const migrateIdx = perform.indexOf('run_migrate');
    const rollIdx = perform.indexOf('roll_or_recreate');
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(rollIdx).toBeGreaterThan(migrateIdx);
    // A failed migration aborts before anything is swapped.
    expect(perform).toContain('run_migrate || return 1');
  });

  test('updater.sh leaves the old version serving when the new replicas never become healthy', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('never became healthy; removing them and keeping the previous version serving');
    const rollFn = script.slice(script.indexOf('roll_service()'), script.indexOf('recreate_service()'));
    // The failure branch removes the NEW containers, never the old ones.
    expect(rollFn).toContain('remove_containers $new_ids');
    const failureBranch = rollFn.slice(rollFn.indexOf('else'));
    expect(failureBranch).not.toContain('remove_containers $old_ids');
  });

  test('updater.sh has a KORTIX_ALLOW_DOWNTIME escape hatch: stop-old then migrate then start-new', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('KORTIX_ALLOW_DOWNTIME');
    const downtimeFn = script.slice(script.indexOf('downtime_swap()'), script.indexOf('reconcile_stateful_services()'));
    const stopIdx = downtimeFn.indexOf('rm --stop --force');
    const migrateIdx = downtimeFn.indexOf('run_migrate');
    const startIdx = downtimeFn.indexOf("up -d --no-deps --scale");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(stopIdx);
    expect(startIdx).toBeGreaterThan(migrateIdx);
  });

  test('updater.sh supports a one-shot "once" mode for a manual on-demand update', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('"${1:-}" = "once"');
  });

  test('updater.sh falls back to an in-place recreate for a service publishing a host port (laptop mode)', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('publishes_host_port');
    expect(script).toContain('recreate_service');
  });

  test('writes the Caddyfile and updater script to the instance directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-runtime-assets-'));
    try {
      writeKortixRuntimeAssets(root);
      expect(readFileSync(join(root, 'Caddyfile'), 'utf8')).toBe(kortixRuntimeAssets.Caddyfile);
      expect(readFileSync(join(root, 'updater.sh'), 'utf8')).toBe(kortixRuntimeAssets['updater.sh']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('embeds every upstream runtime asset required by the Compose mounts', () => {
    expect(Object.keys(supabaseVendorAssets).sort()).toEqual([
      'volumes/api/kong-entrypoint.sh',
      'volumes/api/kong.yml',
      'volumes/db/_supabase.sql',
      'volumes/db/jwt.sql',
      'volumes/db/logs.sql',
      'volumes/db/pooler.sql',
      'volumes/db/realtime.sql',
      'volumes/db/roles.sql',
      'volumes/db/webhooks.sql',
      'volumes/functions/hello/index.ts',
      'volumes/functions/main/index.ts',
      'volumes/logs/vector.yml',
      'volumes/pooler/pooler.exs',
    ]);
    for (const [path, content] of Object.entries(supabaseVendorAssets)) {
      expect(content.length, `${path} must not be empty`).toBeGreaterThan(10);
    }
  });

  test('writes bind-mounted assets with container-readable modes', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-supabase-assets-'));
    try {
      writeSupabaseVendorAssets(root);

      for (const relativePath of Object.keys(supabaseVendorAssets)) {
        const mode = statSync(join(root, relativePath)).mode & 0o777;
        expect(mode, relativePath).toBe(relativePath.endsWith('.sh') ? 0o755 : 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exports a Supabase-only official Docker distribution for AWS hosts', () => {
    expect(Object.keys(officialSupabaseDockerAssets).sort()).toEqual([
      'docker-compose.logs.yml',
      'docker-compose.yml',
      ...Object.keys(supabaseVendorAssets),
    ].sort());

    const document = parse(officialSupabaseDockerAssets['docker-compose.yml']!) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(document.services).sort()).toEqual([
      'auth',
      'db',
      'functions',
      'imgproxy',
      'kong',
      'meta',
      'realtime',
      'rest',
      'storage',
      'studio',
      'supavisor',
    ]);
    const logs = parse(officialSupabaseDockerAssets['docker-compose.logs.yml']!) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(logs.services).sort()).toEqual(['analytics', 'studio', 'vector']);
    expect(document.services).not.toHaveProperty('kortix-api');
    expect(document.services).not.toHaveProperty('frontend');
    expect(document.services).not.toHaveProperty('llm-gateway');
  });

  test('writes the complete Supabase-only Docker distribution', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-official-supabase-assets-'));
    try {
      writeOfficialSupabaseDockerAssets(root);

      for (const [relativePath, content] of Object.entries(officialSupabaseDockerAssets)) {
        expect(readFileSync(join(root, relativePath), 'utf8'), relativePath).toBe(content);
        const mode = statSync(join(root, relativePath)).mode & 0o777;
        expect(mode, relativePath).toBe(relativePath.endsWith('.sh') ? 0o755 : 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('matches the reviewed upstream commit and content lock', () => {
    const lock = JSON.parse(
      readFileSync(new URL('../assets/supabase/upstream-lock.json', import.meta.url), 'utf8'),
    ) as { commit: string; files: Record<string, string> };
    expect(lock.commit).toBe(SUPABASE_UPSTREAM_COMMIT);

    const embeddedFiles: Record<string, string> = {
      'docker-compose.yml': readFileSync(new URL('../assets/supabase/docker-compose.yml', import.meta.url), 'utf8'),
      'docker-compose.logs.yml': readFileSync(new URL('../assets/supabase/docker-compose.logs.yml', import.meta.url), 'utf8'),
      ...Object.fromEntries(
        Object.entries(supabaseVendorAssets).map(([path, content]) => [
          path.endsWith('/index.ts') ? `${path}.txt` : path,
          content,
        ]),
      ),
    };
    expect(Object.keys(embeddedFiles).sort()).toEqual(Object.keys(lock.files).sort());
    for (const [path, content] of Object.entries(embeddedFiles)) {
      expect(createHash('sha256').update(content).digest('hex'), path).toBe(lock.files[path]);
    }
  });

  test('locks every official Supabase image tag to a reviewed OCI digest', () => {
    const upstreamReferences = Object.values(supabaseUpstreamDockerAssets).flatMap((compose) => {
      const document = parse(compose) as { services: Record<string, { image?: string }> };
      return Object.values(document.services).flatMap((service) => service.image ? [service.image] : []);
    }).sort();
    expect(Object.keys(SUPABASE_IMAGE_DIGESTS).sort()).toEqual(upstreamReferences);

    for (const compose of [
      officialSupabaseDockerAssets['docker-compose.yml']!,
      officialSupabaseDockerAssets['docker-compose.logs.yml']!,
    ]) {
      const document = parse(compose) as { services: Record<string, { image?: string }> };
      for (const [name, service] of Object.entries(document.services)) {
        if (!service.image) continue;
        const [reference, digest] = service.image.split('@');
        expect(digest, name).toBe(SUPABASE_IMAGE_DIGESTS[reference!]);
      }
    }
  });
});
