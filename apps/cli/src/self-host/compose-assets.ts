import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';

import kortixCompose from './assets/kortix-compose.yml' with { type: 'text' };
import supabaseCompose from './assets/supabase/docker-compose.yml' with { type: 'text' };
import supabaseLogsCompose from './assets/supabase/docker-compose.logs.yml' with { type: 'text' };
import kongEntrypoint from './assets/supabase/volumes/api/kong-entrypoint.sh' with { type: 'text' };
import kongConfig from './assets/supabase/volumes/api/kong.yml' with { type: 'text' };
import supabaseInternalSql from './assets/supabase/volumes/db/_supabase.sql' with { type: 'text' };
import jwtSql from './assets/supabase/volumes/db/jwt.sql' with { type: 'text' };
import logsSql from './assets/supabase/volumes/db/logs.sql' with { type: 'text' };
import poolerSql from './assets/supabase/volumes/db/pooler.sql' with { type: 'text' };
import realtimeSql from './assets/supabase/volumes/db/realtime.sql' with { type: 'text' };
import rolesSql from './assets/supabase/volumes/db/roles.sql' with { type: 'text' };
import webhooksSql from './assets/supabase/volumes/db/webhooks.sql' with { type: 'text' };
import helloFunction from './assets/supabase/volumes/functions/hello/index.ts.txt' with { type: 'text' };
import mainFunction from './assets/supabase/volumes/functions/main/index.ts.txt' with { type: 'text' };
import vectorConfig from './assets/supabase/volumes/logs/vector.yml' with { type: 'text' };
import poolerConfig from './assets/supabase/volumes/pooler/pooler.exs' with { type: 'text' };

type YamlRecord = Record<string, unknown>;

const SERVICE_NAMES: Record<string, string> = {
  studio: 'supabase-studio',
  kong: 'supabase-kong',
  auth: 'supabase-auth',
  rest: 'supabase-rest',
  realtime: 'supabase-realtime',
  storage: 'supabase-storage',
  imgproxy: 'supabase-imgproxy',
  meta: 'supabase-meta',
  functions: 'supabase-functions',
  db: 'supabase-db',
  supavisor: 'supabase-supavisor',
  analytics: 'supabase-analytics',
  vector: 'supabase-vector',
};

export const SUPABASE_UPSTREAM_COMMIT = '20649d23740e2facc5d11f7220947b9cddf9480c';

export const supabaseVendorAssets: Readonly<Record<string, string>> = {
  'volumes/api/kong-entrypoint.sh': kongEntrypoint,
  'volumes/api/kong.yml': kongConfig,
  'volumes/db/_supabase.sql': supabaseInternalSql,
  'volumes/db/jwt.sql': jwtSql,
  'volumes/db/logs.sql': logsSql,
  'volumes/db/pooler.sql': poolerSql,
  'volumes/db/realtime.sql': realtimeSql,
  'volumes/db/roles.sql': rolesSql,
  'volumes/db/webhooks.sql': webhooksSql,
  'volumes/functions/hello/index.ts': helloFunction,
  'volumes/functions/main/index.ts': mainFunction,
  'volumes/logs/vector.yml': vectorConfig,
  'volumes/pooler/pooler.exs': poolerConfig,
};

/**
 * Compose the pinned official Supabase Docker distribution with the Kortix
 * application services. The upstream service definitions and image pins stay
 * intact; we only remove globally-conflicting container names, add legacy
 * Kortix service names, and restrict every published port to loopback.
 */
export function renderFullDockerCompose(composeProject: string): string {
  const base = parse(
    supabaseCompose.replaceAll('${POSTGRES_PORT}', '${SUPABASE_POSTGRES_INTERNAL_PORT}'),
  ) as YamlRecord;
  const logs = parse(
    supabaseLogsCompose.replaceAll('${POSTGRES_PORT}', '${SUPABASE_POSTGRES_INTERNAL_PORT}'),
  ) as YamlRecord;
  const kortix = parse(
    kortixCompose.replaceAll('__KORTIX_COMPOSE_PROJECT__', composeProject),
  ) as YamlRecord;

  const upstreamServices = deepMerge(
    asRecord(base.services),
    asRecord(logs.services),
  ) as Record<string, YamlRecord>;
  const services: Record<string, YamlRecord> = {};

  for (const [upstreamName, rawService] of Object.entries(upstreamServices)) {
    const serviceName = SERVICE_NAMES[upstreamName] ?? upstreamName;
    const service = structuredClone(rawService);
    delete service.container_name;
    service.depends_on = renameDependencies(service.depends_on);
    service.networks = addNetworkAlias(service.networks, upstreamName);
    services[serviceName] = service;
  }

  const kong = services['supabase-kong'];
  if (kong) kong.ports = ['127.0.0.1:${SUPABASE_PORT}:8000'];
  const database = services['supabase-db'];
  if (database) {
    // `pg_isready` succeeds against the temporary server that the Postgres
    // entrypoint uses while running init scripts. Auth can therefore start
    // before the late 99-roles.sql script has assigned its password and enter
    // a permanent restart loop. The temporary init server can also accept a
    // successful query and then shut down underneath a just-started Auth
    // process, so require PID 1 to be the final postgres process as well as a
    // real password-authenticated query using Auth's role. `$$` defers the
    // environment expansion from Compose to the healthcheck container.
    database.healthcheck = {
      test: [
        'CMD-SHELL',
        'tr \'\\0\' \' \' </proc/1/cmdline | grep -q \'/postgres \' && PGPASSWORD="$${POSTGRES_PASSWORD}" psql -h 127.0.0.1 -U supabase_auth_admin -d "$${POSTGRES_DB}" -tAc \'select 1\' >/dev/null',
      ],
      interval: '5s',
      timeout: '5s',
      retries: 20,
      start_period: '10s',
    };
  }
  const supavisor = services['supabase-supavisor'];
  if (supavisor) {
    supavisor.ports = [
      '127.0.0.1:${POSTGRES_PORT}:5432',
      '127.0.0.1:${POOLER_PORT}:6543',
    ];
  }

  for (const [name, rawService] of Object.entries(asRecord(kortix.services))) {
    services[name] = rawService as YamlRecord;
  }

  const document: YamlRecord = {
    services,
    volumes: deepMerge(asRecord(base.volumes), asRecord(kortix.volumes)),
  };
  return stringify(document, { lineWidth: 0 });
}

export function writeSupabaseVendorAssets(root: string): void {
  for (const [relativePath, content] of Object.entries(supabaseVendorAssets)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { encoding: 'utf8', mode: relativePath.endsWith('.sh') ? 0o700 : 0o600 });
    if (relativePath.endsWith('.sh')) chmodSync(path, 0o700);
  }
  mkdirSync(join(root, 'volumes', 'db', 'data'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'volumes', 'storage'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'volumes', 'snippets'), { recursive: true, mode: 0o700 });
}

function renameDependencies(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, condition]) => [SERVICE_NAMES[name] ?? name, condition]),
  );
}

function addNetworkAlias(value: unknown, alias: string): YamlRecord {
  const networks = isRecord(value) ? structuredClone(value) : {};
  const currentDefault = isRecord(networks.default) ? networks.default : {};
  const aliases = Array.isArray(currentDefault.aliases)
    ? currentDefault.aliases.filter((item): item is string => typeof item === 'string')
    : [];
  currentDefault.aliases = [...new Set([...aliases, alias])];
  networks.default = currentDefault;
  return networks;
}

function deepMerge(left: YamlRecord, right: YamlRecord): YamlRecord {
  const merged: YamlRecord = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    const previous = merged[key];
    merged[key] = isRecord(previous) && isRecord(value)
      ? deepMerge(previous, value)
      : structuredClone(value);
  }
  return merged;
}

function asRecord(value: unknown): YamlRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is YamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
