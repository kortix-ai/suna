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

  test('the kortix-updater service is always present and mounts the docker socket', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { volumes?: string[]; environment?: Record<string, string> }>;
    };
    const updater = document.services['kortix-updater'];
    expect(updater).toBeDefined();
    expect(updater?.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(updater?.environment).toHaveProperty('KORTIX_AUTO_UPDATE');
    expect(updater?.environment).toHaveProperty('KORTIX_UPDATE_INTERVAL');
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
