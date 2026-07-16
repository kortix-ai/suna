import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';

import kortixCompose from './assets/kortix-compose.yml' with { type: 'text' };
import kortixCaddyfile from './assets/Caddyfile.txt' with { type: 'text' };
import kortixUpdaterScript from './assets/updater.sh' with { type: 'text' };
import upstreamSupabaseCompose from './assets/supabase/docker-compose.yml' with { type: 'text' };
import upstreamSupabaseLogsCompose from './assets/supabase/docker-compose.logs.yml' with { type: 'text' };
import supabaseImageLockText from './assets/supabase/image-lock.json' with { type: 'text' };
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

export const supabaseUpstreamDockerAssets: Readonly<Record<string, string>> = {
  'docker-compose.yml': upstreamSupabaseCompose,
  'docker-compose.logs.yml': upstreamSupabaseLogsCompose,
};

export const SUPABASE_IMAGE_DIGESTS = loadSupabaseImageLock(supabaseImageLockText);

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
 * The pinned official Supabase Docker distribution used on the private EC2
 * data host. Kortix application containers are intentionally absent: the API,
 * frontend, gateway, and workers run on EKS in the AWS VPC topology.
 */
export const officialSupabaseDockerAssets: Readonly<Record<string, string>> = {
  'docker-compose.yml': pinSupabaseImages(upstreamSupabaseCompose),
  'docker-compose.logs.yml': pinSupabaseImages(upstreamSupabaseLogsCompose),
  ...supabaseVendorAssets,
};

/**
 * The Caddyfile + updater script mounted into their respective services.
 * These are plain runtime assets (no secrets) written next to the compose
 * file and .env, same as the Supabase vendor assets.
 */
export const kortixRuntimeAssets: Readonly<Record<string, string>> = {
  Caddyfile: kortixCaddyfile,
  'updater.sh': kortixUpdaterScript,
};

export function writeKortixRuntimeAssets(root: string): void {
  writeAssets(root, kortixRuntimeAssets);
}

export interface RenderComposeOptions {
  /**
   * Whether KORTIX_DOMAIN (and KORTIX_API_DOMAIN) are configured. When true,
   * the `caddy` reverse-proxy/TLS service is included. When false (the
   * laptop/loopback-port default), it is omitted entirely — not merely
   * disabled — so a domain-less instance never binds 80/443.
   */
  domainConfigured?: boolean;
  /**
   * Whether "tunnel" reachability mode is selected (see reachabilityMode() in
   * self-host/tunnel.ts). When true, the `cloudflared` service is included so
   * cloud (Daytona) sandboxes can call back to this instance with no public
   * domain/DNS at all. When false, it is omitted entirely — not merely
   * disabled — so an instance not using it never runs the container.
   */
  tunnelConfigured?: boolean;
  /**
   * Whether a STABLE named Cloudflare tunnel is configured (both
   * CLOUDFLARE_TUNNEL_TOKEN and CLOUDFLARE_TUNNEL_HOSTNAME set — see
   * namedTunnelConfigured() in self-host/tunnel.ts). Only meaningful when
   * tunnelConfigured is also true. Selects the cloudflared service's
   * command/environment at COMPOSE-RENDER time (`tunnel run` + TUNNEL_TOKEN
   * env var vs. the zero-config `tunnel --url` default already baked into
   * kortix-compose.yml) — this can't be a runtime shell branch inside the
   * container because the official cloudflared image ships no shell at all.
   */
  namedTunnelConfigured?: boolean;
  /**
   * Whether the operator selected the EXPERIMENTAL `local-docker` sandbox
   * provider (ALLOWED_SANDBOX_PROVIDERS includes it — see
   * configureIntegrations() in commands/self-host.ts). Only then does
   * kortix-api get the host's Docker socket mounted in (root-equivalent host
   * access) and LOCAL_DOCKER_NETWORK pointed at this Compose project's own
   * default network, so sandbox containers created by the provider
   * (apps/api/src/platform/providers/local-docker.ts) are reachable by
   * Docker DNS name. Omitted entirely — not merely unset — for every other
   * provider, so a Daytona/Platinum/E2B instance never grants kortix-api
   * Docker access it doesn't need.
   */
  localDockerConfigured?: boolean;
}

/**
 * The stateless app-tier services the auto-updater rolls start-first. Kept in
 * one place so the replica/port topology below and updater.sh agree on the
 * exact same service set.
 */
export const ROLLING_APP_SERVICES = ['kortix-api', 'llm-gateway', 'frontend'] as const;

/**
 * Replica count for each rolling service per topology. Exported so the CLI's
 * env writer (commands/self-host.ts) can set the exact same number into
 * KORTIX_APP_REPLICAS — the single source of truth the auto-updater reads to
 * know its start-first rollout target, instead of re-deriving prod-vs-laptop
 * topology itself.
 */
export const PROD_APP_REPLICAS = 2;
export const LAPTOP_APP_REPLICAS = 1;

/**
 * Compose the pinned official Supabase Docker distribution with the Kortix
 * application services. The upstream service definitions and image pins stay
 * intact; we only remove globally-conflicting container names, add legacy
 * Kortix service names, and restrict every published port to loopback.
 */
export function renderFullDockerCompose(composeProject: string, options: RenderComposeOptions = {}): string {
  const base = parse(
    officialSupabaseDockerAssets['docker-compose.yml']!.replaceAll('${POSTGRES_PORT}', '${SUPABASE_POSTGRES_INTERNAL_PORT}'),
  ) as YamlRecord;
  const logs = parse(
    officialSupabaseDockerAssets['docker-compose.logs.yml']!.replaceAll('${POSTGRES_PORT}', '${SUPABASE_POSTGRES_INTERNAL_PORT}'),
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
  if (kong) {
    kong.ports = ['127.0.0.1:${SUPABASE_PORT}:8000'];
    // Upstream declares `depends_on: studio: condition: service_healthy` —
    // but Kong here runs fully declarative (KONG_DATABASE=off, its routes
    // come from the mounted kong.yml), so it has no runtime dependency on
    // Studio at all. Left in place, that one line puts Studio — and, once
    // docker-compose.logs.yml is merged in (always, in self-host — see
    // upstreamServices above), Studio's OWN dependency on Logflare/Analytics
    // — on the critical path of every service that itself depends on Kong
    // (kortix-api's SUPABASE_URL points at Kong, so kortix-api transitively
    // waited on the admin dashboard and the analytics pipeline before it
    // could even start). None of Studio/Logflare/Analytics are on the
    // customer-facing request path; un-gating Kong from Studio removes them
    // from kortix-api's cold-boot chain without touching either service.
    if (isRecord(kong.depends_on)) {
      const dependencies = { ...kong.depends_on };
      delete dependencies['supabase-studio'];
      kong.depends_on = Object.keys(dependencies).length > 0 ? dependencies : undefined;
    }
  }
  const auth = services['supabase-auth'];
  if (auth) {
    // GoTrue silently no-ops EVERY per-IP rate limit (email/SMS/OTP sent,
    // token refresh, anonymous sign-ins, ...) when GOTRUE_RATE_LIMIT_HEADER
    // is unset — see performRateLimitingWithHeader() in supabase/auth: "If no
    // rate limit header was set, ignore rate limiting". Upstream's compose
    // file never sets it, so a self-host instance runs with every one of
    // these protections silently disabled regardless of their (non-zero)
    // numeric defaults. Kong/Caddy both set X-Forwarded-For on proxied
    // requests by default, so pointing GoTrue at that header is enough to
    // turn the existing defaults into real protection; the explicit values
    // below just make the floor visible instead of relying on GoTrue's own
    // internal defaults changing out from under this file on a version bump.
    const authEnv = { ...asRecord(auth.environment) } as Record<string, string>;
    authEnv.GOTRUE_RATE_LIMIT_HEADER ||= 'X-Forwarded-For';
    authEnv.GOTRUE_RATE_LIMIT_EMAIL_SENT ||= '30';
    authEnv.GOTRUE_RATE_LIMIT_SMS_SENT ||= '30';
    authEnv.GOTRUE_RATE_LIMIT_VERIFY ||= '30';
    authEnv.GOTRUE_RATE_LIMIT_TOKEN_REFRESH ||= '150';
    authEnv.GOTRUE_RATE_LIMIT_OTP ||= '30';
    authEnv.GOTRUE_RATE_LIMIT_ANONYMOUS_USERS ||= '30';
    auth.environment = authEnv;
  }
  const database = services['supabase-db'];
  if (database) {
    // `pg_isready` succeeds against the temporary server that the Postgres
    // entrypoint uses while running init scripts. Auth can therefore start
    // before the late 99-roles.sql script has assigned its password and enter
    // a permanent restart loop. The temporary init server can also accept a
    // successful query and then shut down underneath a just-started Auth
    // process, so require PID 1 to be the final postgres process as well as a
    // real password-authenticated query using Auth's role over the Docker
    // network. The network hop is important: localhost can use a more
    // permissive pg_hba rule than Auth's container and hide a bad role
    // password. `$$` defers environment expansion from Compose to the
    // healthcheck container.
    database.healthcheck = {
      test: [
        'CMD-SHELL',
        'tr \'\\0\' \' \' </proc/1/cmdline | grep -q \'/postgres \' && PGPASSWORD="$${POSTGRES_PASSWORD}" psql -h supabase-db -U supabase_auth_admin -d "$${POSTGRES_DB}" -tAc \'select 1\' >/dev/null',
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
    // supavisor's entrypoint (limits.sh) unconditionally runs `ulimit -n 100000`
    // before starting. Containers with no explicit `ulimits:` inherit the
    // HOST's default open-files limit (systemd DefaultLimitNOFILE, or
    // /etc/security/limits.conf) rather than something generously high — on
    // plenty of real VPS/EC2 images that default is well under 100000 (e.g.
    // 65535), `ulimit -n 100000` then fails with EPERM, and (the script running
    // under `set -e`) the container exits 1 and restart-loops forever, so
    // Postgres access via the pooler never comes up. Pin it explicitly so this
    // doesn't depend on host ulimit defaults. Matches the old enterprise
    // appliance's docker-compose.enterprise.yml override for this service.
    supavisor.ulimits = {
      nofile: {
        soft: 100000,
        hard: 100000,
      },
    };
  }

  for (const [name, rawService] of Object.entries(asRecord(kortix.services))) {
    services[name] = rawService as YamlRecord;
  }

  // local-docker (EXPERIMENTAL) is opt-in, same shape as the Caddy/cloudflared
  // blocks below: mutate the already-parsed kortix-api service object rather
  // than baking a static (always-present) block into kortix-compose.yml, so a
  // non-local-docker instance's rendered compose never even mentions the
  // Docker socket.
  if (options.localDockerConfigured) {
    const api = services['kortix-api'];
    if (api) {
      const existingVolumes = Array.isArray(api.volumes) ? api.volumes : [];
      api.volumes = [...existingVolumes, '/var/run/docker.sock:/var/run/docker.sock'];
      const existingEnv = isRecord(api.environment) ? api.environment : {};
      api.environment = {
        ...existingEnv,
        // Sandbox containers land on THIS Compose project's own default
        // network (the same one every other service here joins), so
        // kortix-api reaches them by Docker DNS name
        // (http://kortix-sb-<id>:<port> — see local-docker.ts).
        LOCAL_DOCKER_NETWORK: `${composeProject}_default`,
      };
    }
  }

  // The Caddy reverse-proxy/TLS service is opt-in: it only makes sense (and
  // only binds 80/443) when a public domain is configured. Omit it entirely —
  // rather than just leaving it stopped — so a domain-less laptop/VPS
  // instance never even has the option of a port clash on 80/443.
  if (!options.domainConfigured) {
    delete services.caddy;
  }

  // The Cloudflare tunnel service is likewise opt-in: only present when
  // tunnel reachability mode is selected. Omitted entirely (not just
  // stopped) otherwise, so an instance not using it never even pulls the
  // cloudflared image.
  if (!options.tunnelConfigured) {
    delete services.cloudflared;
  } else if (options.namedTunnelConfigured) {
    // Stable named tunnel: authenticate with TUNNEL_TOKEN (cloudflared reads
    // it natively — no CLI flag/shell needed) and run the tunnel bound to
    // that token instead of minting a new zero-config quick tunnel.
    const cloudflared = services.cloudflared;
    if (cloudflared) {
      cloudflared.command = ['tunnel', '--no-autoupdate', 'run'];
      cloudflared.environment = { TUNNEL_TOKEN: '${CLOUDFLARE_TUNNEL_TOKEN}' };
    }
  }

  // Prod (domain-configured) vs laptop replica/port topology. In prod mode
  // Caddy is the single edge and reaches every app-tier service by Docker DNS
  // (see assets/Caddyfile.txt's `dynamic a` upstreams), so the app services run
  // 2 replicas each with NO host-port publishing — publishing a static host
  // port would collide the moment a second replica starts. In laptop mode
  // there is no edge/LB and no need for zero-downtime rollouts, so each
  // service stays a single replica on its existing loopback host port. The
  // in-compose auto-updater (updater.sh) reads this same signal back out of
  // .env via KORTIX_APP_REPLICAS so its start-first rollout targets the right
  // replica count without re-deriving it from the compose file at runtime.
  applyReplicaTopology(services, Boolean(options.domainConfigured));

  // Every one of the ~20 containers in this stack logged to stdout with no
  // rotation — an unattended VPS eventually fills its disk from container
  // logs alone. Applied uniformly, after every other service-specific tweak
  // above, so nothing here can be silently skipped for one service and not
  // another (a hand-maintained per-file `logging:`/`x-logging` block invites
  // exactly that drift).
  applyLogging(services);
  // Sensible memory ceilings so one hungry/leaking service can't starve the
  // host and get Postgres OOM-killed — see applyMemLimits() for the
  // measurements this table is derived from.
  applyMemLimits(services);

  const document: YamlRecord = {
    services,
    volumes: deepMerge(asRecord(base.volumes), asRecord(kortix.volumes)),
  };
  return stringify(document, { lineWidth: 0 });
}

export function writeSupabaseVendorAssets(root: string): void {
  writeAssets(root, supabaseVendorAssets);
  writeSupabaseDataDirectories(root);
}

export function writeOfficialSupabaseDockerAssets(root: string): void {
  writeAssets(root, officialSupabaseDockerAssets);
  writeSupabaseDataDirectories(root);
}

function writeAssets(root: string, assets: Readonly<Record<string, string>>): void {
  for (const [relativePath, content] of Object.entries(assets)) {
    const path = join(root, relativePath);
    const mode = relativePath.endsWith('.sh') ? 0o755 : 0o644;
    mkdirSync(dirname(path), { recursive: true });
    // These files are bind-mounted into containers that intentionally run as
    // non-root users. Docker Desktop can mask restrictive host modes, while a
    // native Linux Docker engine preserves them and rejects a 0600 SQL/config
    // file owned by the host user. The assets contain no secrets; runtime
    // secrets remain in the separately protected .env file.
    writeFileSync(path, content, { encoding: 'utf8', mode });
    // `mode` only applies when creating a file. Reconcile an existing install
    // too so upgrading repairs assets emitted by an older CLI.
    chmodSync(path, mode);
  }
}

function writeSupabaseDataDirectories(root: string): void {
  mkdirSync(join(root, 'volumes', 'db', 'data'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'volumes', 'storage'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'volumes', 'snippets'), { recursive: true, mode: 0o700 });
}

/**
 * Apply the prod-vs-laptop replica/port topology to the stateless app-tier
 * services (see ROLLING_APP_SERVICES). Prod mode: `deploy.replicas: 2`, no
 * `ports` (Caddy is the only thing that ever needs to reach them, over the
 * Compose network by service name). Laptop mode: single replica, existing
 * loopback `ports` mapping left untouched.
 */
function applyReplicaTopology(services: Record<string, YamlRecord>, domainConfigured: boolean): void {
  const replicas = domainConfigured ? PROD_APP_REPLICAS : LAPTOP_APP_REPLICAS;
  for (const name of ROLLING_APP_SERVICES) {
    const service = services[name];
    if (!service) continue;
    if (domainConfigured) delete service.ports;
    service.deploy = { replicas };
  }
}

/**
 * Bounded, rotated logs for every container in the stack (compose's own
 * `logging:` key — the default `json-file` driver otherwise grows without
 * bound). One shared literal applied uniformly at render time is this
 * generator's equivalent of a compose-level `x-logging` anchor: every
 * service gets exactly this, and a future service added to either the
 * upstream Supabase file or kortix-compose.yml picks it up automatically
 * with no per-file edit required.
 */
const DEFAULT_LOGGING: YamlRecord = {
  driver: 'json-file',
  options: { 'max-size': '10m', 'max-file': '3' },
};

function applyLogging(services: Record<string, YamlRecord>): void {
  for (const service of Object.values(services)) {
    service.logging = structuredClone(DEFAULT_LOGGING);
  }
}

/**
 * Per-service memory ceiling/floor, keyed by the FINAL (post-SERVICE_NAMES
 * rename) service name. Not a strict admission-control budget — these are
 * hard per-container ceilings sized well above ordinary usage, meant to stop
 * a single runaway/leaking service before it can starve the host and get
 * Postgres OOM-killed (the actual live-audit failure mode: a 16GB box
 * idling at ~4GB total, with Logflare/analytics alone accounting for
 * ~500MB of that). `mem_limit`/`mem_reservation` are plain Compose-spec
 * fields honored by a bare `docker compose up` — unlike `deploy.resources`,
 * they don't require Swarm mode. `oomScoreAdj` (compose's `oom_score_adj`,
 * -1000..1000) biases the kernel OOM-killer directly: very negative for
 * Postgres (protect it hard), positive for the least-critical
 * logs/analytics pipeline (first to go if the host is ever actually under
 * memory pressure). Every limit here is a conservative ceiling chosen so the
 * full table summed together still comfortably fits an 8GB box even though
 * no realistic self-host workload pegs every service at its cap
 * simultaneously.
 */
interface MemSpec {
  limit: string;
  reservation: string;
  oomScoreAdj?: number;
}

const MEM_LIMITS: Readonly<Record<string, MemSpec>> = {
  'supabase-db': { limit: '1280m', reservation: '512m', oomScoreAdj: -900 },
  'kortix-api': { limit: '640m', reservation: '256m' },
  'llm-gateway': { limit: '512m', reservation: '128m' },
  frontend: { limit: '512m', reservation: '128m' },
  'kortix-migrate': { limit: '512m', reservation: '128m' },
  'kortix-updater': { limit: '256m', reservation: '64m' },
  'supabase-kong': { limit: '384m', reservation: '128m' },
  'supabase-auth': { limit: '256m', reservation: '64m' },
  'supabase-rest': { limit: '256m', reservation: '64m' },
  'supabase-realtime': { limit: '384m', reservation: '128m' },
  'supabase-storage': { limit: '384m', reservation: '128m' },
  'supabase-imgproxy': { limit: '384m', reservation: '64m' },
  'supabase-meta': { limit: '256m', reservation: '64m' },
  'supabase-functions': { limit: '384m', reservation: '128m' },
  'supabase-supavisor': { limit: '384m', reservation: '128m' },
  'supabase-studio': { limit: '384m', reservation: '128m' },
  // The audit's confirmed hog (~500MB observed) — tightest cap, and the
  // first thing the kernel OOM-killer should reach for.
  'supabase-analytics': { limit: '640m', reservation: '256m', oomScoreAdj: 500 },
  'supabase-vector': { limit: '192m', reservation: '64m', oomScoreAdj: 500 },
  caddy: { limit: '256m', reservation: '64m' },
  cloudflared: { limit: '128m', reservation: '32m' },
};

function applyMemLimits(services: Record<string, YamlRecord>): void {
  for (const [name, spec] of Object.entries(MEM_LIMITS)) {
    const service = services[name];
    if (!service) continue;
    service.mem_limit = spec.limit;
    service.mem_reservation = spec.reservation;
    if (spec.oomScoreAdj !== undefined) service.oom_score_adj = spec.oomScoreAdj;
  }
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

function loadSupabaseImageLock(value: unknown): Readonly<Record<string, string>> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!isRecord(parsed)
    || parsed.schema_version !== 1
    || parsed.supabase_upstream_commit !== SUPABASE_UPSTREAM_COMMIT
    || !isRecord(parsed.images)) {
    throw new Error('Supabase image lock does not match the reviewed upstream distribution');
  }
  const images = parsed.images as Record<string, unknown>;
  for (const [reference, digest] of Object.entries(images)) {
    if (!/^[a-z0-9][a-z0-9./_-]+:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(reference)
      || typeof digest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`invalid immutable Supabase image lock entry: ${reference}`);
    }
  }
  return Object.freeze(images as Record<string, string>);
}

function pinSupabaseImages(value: string): string {
  const document = parse(value) as YamlRecord;
  const services = asRecord(document.services);
  const used = new Set<string>();
  for (const [name, rawService] of Object.entries(services)) {
    const service = asRecord(rawService);
    if (typeof service.image !== 'string') continue;
    const digest = SUPABASE_IMAGE_DIGESTS[service.image];
    if (!digest) throw new Error(`Supabase service ${name} image is absent from the immutable image lock`);
    used.add(service.image);
    service.image = `${service.image}@${digest}`;
  }
  const unused = Object.keys(SUPABASE_IMAGE_DIGESTS).filter((reference) => !used.has(reference)
    && !Object.values(supabaseUpstreamDockerAssets).some((compose) => compose.includes(`image: ${reference}`)));
  if (unused.length > 0) throw new Error(`Supabase image lock contains unused entries: ${unused.join(', ')}`);
  return `# Generated from Supabase ${SUPABASE_UPSTREAM_COMMIT}; image tags are locked to reviewed OCI digests.\n${stringify(document, { lineWidth: 0 })}`;
}
