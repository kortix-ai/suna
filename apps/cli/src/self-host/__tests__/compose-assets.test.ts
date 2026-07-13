import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

import {
  renderFullDockerCompose,
  SUPABASE_UPSTREAM_COMMIT,
  supabaseVendorAssets,
} from '../compose-assets.ts';

describe('full self-host Docker distribution', () => {
  test('renders the complete pinned Supabase and Kortix service set', () => {
    const document = parse(renderFullDockerCompose('kortix-enterprise')) as {
      services: Record<string, {
        image?: string;
        container_name?: string;
        ports?: string[];
        depends_on?: Record<string, unknown>;
      }>;
    };

    expect(Object.keys(document.services).sort()).toEqual([
      'frontend',
      'kortix-api',
      'kortix-migrate',
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
    expect(document.services['supabase-db']?.image).toBe('supabase/postgres:17.6.1.136');
    expect(document.services['supabase-studio']?.image).toBe('supabase/studio:2026.07.07-sha-a6a04f2');
    expect(document.services['supabase-analytics']?.image).toBe('supabase/logflare:1.43.1');

    for (const [name, service] of Object.entries(document.services)) {
      expect(service.container_name, `${name} must support multiple Kortix instances`).toBeUndefined();
      if (service.image && !service.image.startsWith('${')) {
        expect(service.image, `${name} image must be immutable`).not.toEndWith(':latest');
      }
      for (const port of service.ports ?? []) {
        expect(port, `${name} must bind only on loopback`).toStartWith('127.0.0.1:');
      }
      for (const dependency of Object.keys(service.depends_on ?? {})) {
        expect(document.services[dependency], `${name} depends on missing ${dependency}`).toBeDefined();
      }
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
});
