import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SUPABASE_IMAGE_DIGESTS,
  SUPABASE_UPSTREAM_COMMIT,
  writeOfficialSupabaseDockerAssets,
} from '../../cli/src/self-host/compose-assets.ts';

export interface SupabaseBundleDescriptor {
  schema_version: 1;
  kind: 'kortix-enterprise-supabase';
  version: string;
  supabase_upstream_commit: string;
  compose_files: ['docker-compose.yml', 'docker-compose.logs.yml', 'docker-compose.enterprise.yml'];
  persistent_paths: {
    'volumes/db/data': '/var/lib/kortix/postgres';
    'volumes/storage': '/var/lib/kortix/storage';
  };
  image_digests: Record<string, string>;
  required_services: string[];
}

/**
 * The signed application bundle. It carries the whole Kortix app tier as one
 * Docker Compose stack (Caddy + api ×2 + gateway + frontend) with every app
 * image digest-pinned from the release manifest, plus the systemd units and
 * self-healing timers that keep the single box alive between updates. This slot
 * previously held the post-cluster DNS Terraform stage; the appliance model runs
 * 100% Docker on one host, so the manifest's platform_bundle now delivers this.
 */
export interface AppBundleDescriptor {
  schema_version: 1;
  kind: 'kortix-enterprise-app';
  version: string;
  compose_files: ['docker-compose.yml'];
  persistent_paths: {
    caddy: '/var/lib/kortix/caddy';
  };
  /** Digest lock for the three manifest-supplied app images (sha256:<64hex>). */
  image_digests: Record<AppImageRole, string>;
  required_services: string[];
}

export type AppImageRole = 'api' | 'frontend' | 'gateway';
const APP_IMAGE_ROLES: AppImageRole[] = ['api', 'frontend', 'gateway'];
const SHA256 = /^sha256:[a-f0-9]{64}$/;

const ENTERPRISE_VERSION = /^\d+\.\d+\.\d+-e[1-9]\d*$/;

/** Single-flight lock the updater holds; the watchdog respects it too. */
const UPDATER_LOCK = '/var/lib/kortix/updater.lock';

export function materializeSupabaseBundle(root: string, version: string): SupabaseBundleDescriptor {
  if (!ENTERPRISE_VERSION.test(version)) {
    throw new Error('enterprise bundle version must use <prod-version>-e<revision>');
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeOfficialSupabaseDockerAssets(root);
  writeFileSync(join(root, 'docker-compose.enterprise.yml'), enterpriseSupabaseOverlay(), { mode: 0o644 });

  const descriptor: SupabaseBundleDescriptor = {
    schema_version: 1,
    kind: 'kortix-enterprise-supabase',
    version,
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
  };
  writeFileSync(join(root, 'bundle.json'), `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  writeExecutable(join(root, 'bin', 'install'), supabaseHostInstallScript());
  writeExecutable(join(root, 'bin', 'supabase-start'), supabaseStartScript());
  writeExecutable(join(root, 'bin', 'supabase-stop'), supabaseStopScript());
  return descriptor;
}

/**
 * Materialize the signed app bundle: one Docker Compose stack (Caddy + api ×2 +
 * gateway + frontend), a Caddyfile implementing the appliance routing table, the
 * install/start/stop scripts, and the systemd units + self-healing timers. Every
 * app image is digest-pinned from the manifest; the registry base (customer ECR
 * on AWS, Docker Hub elsewhere) is bound at install time by the updater.
 */
export function materializeAppBundle(
  root: string,
  version: string,
  imageDigests: Record<AppImageRole, string>,
): AppBundleDescriptor {
  if (!ENTERPRISE_VERSION.test(version)) {
    throw new Error('enterprise bundle version must use <prod-version>-e<revision>');
  }
  for (const role of APP_IMAGE_ROLES) {
    if (!SHA256.test(imageDigests[role] ?? '')) {
      throw new Error(`app bundle ${role} image digest must be sha256:<64 lowercase hex>`);
    }
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const descriptor: AppBundleDescriptor = {
    schema_version: 1,
    kind: 'kortix-enterprise-app',
    version,
    compose_files: ['docker-compose.yml'],
    persistent_paths: { caddy: '/var/lib/kortix/caddy' },
    image_digests: {
      api: imageDigests.api,
      frontend: imageDigests.frontend,
      gateway: imageDigests.gateway,
    },
    required_services: ['api', 'caddy', 'frontend', 'gateway'],
  };

  writeFileSync(join(root, 'docker-compose.yml'), appDockerCompose(), { mode: 0o644 });
  writeFileSync(join(root, 'Caddyfile'), appCaddyfile(), { mode: 0o644 });
  writeFileSync(join(root, 'bundle.json'), `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  writeExecutable(join(root, 'bin', 'install'), appInstallScript());
  writeExecutable(join(root, 'bin', 'app-start'), appStartScript());
  writeExecutable(join(root, 'bin', 'app-stop'), appStopScript());
  writeExecutable(join(root, 'bin', 'watchdog'), appWatchdogScript());
  writeExecutable(join(root, 'bin', 'prune'), appPruneScript());
  for (const [name, unit] of Object.entries(systemdUnits())) {
    writeFileSync(join(mkSystemd(root), name), unit, { mode: 0o644 });
  }
  return descriptor;
}

function mkSystemd(root: string): string {
  const dir = join(root, 'systemd');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

// Docker json-file log caps on every service — dangling logs/images are the #1
// single-box killer, so every service gets bounded logs and every image is
// digest-pinned via env (install enforces the digest lock against bundle.json).
const LOG_LIMITS = `    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"`;

const APP_HEALTHCHECK = (port: string, path: string): string =>
  `    healthcheck:
      test: ["CMD-SHELL", "bun -e \\"fetch('http://localhost:${port}${path}').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\\""]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s`;

/**
 * The app-tier compose stack. Caddy owns TLS + routing on 80/443; api runs 2
 * replicas that the updater rolls start-first (never below 2 healthy) and Caddy
 * load-balances by Docker DNS. Every service has restart: always, a real
 * healthcheck, and bounded logs. Images are `${KORTIX_*_IMAGE}` refs the install
 * script pins to the manifest digests. Supabase runs as a separate compose
 * project on the same box; the app reaches Kong via the URLs in .env.
 */
function appDockerCompose(): string {
  return `name: kortix-app
services:
  caddy:
    image: \${KORTIX_CADDY_IMAGE}
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./acme.caddy:/etc/caddy/acme.caddy:ro
      - /var/lib/kortix/caddy:/data
    environment:
      KORTIX_API_DOMAIN: \${KORTIX_API_DOMAIN}
      KORTIX_FRONTEND_DOMAIN: \${KORTIX_FRONTEND_DOMAIN}
      KORTIX_ACME_EMAIL: \${KORTIX_ACME_EMAIL}
      AWS_REGION: \${AWS_BEDROCK_REGION:-}
    depends_on:
      api:
        condition: service_healthy
      gateway:
        condition: service_started
      frontend:
        condition: service_started
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:2019/config/"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 15s
${LOG_LIMITS}

  migrate:
    image: \${KORTIX_API_IMAGE}
    user: "0:0"
    profiles: ["tools"]
    command: ["bun", "/app/packages/db/scripts/migrate.ts", "bootstrap"]
    env_file:
      - .env
    restart: "no"
${LOG_LIMITS}

  api:
    image: \${KORTIX_API_IMAGE}
    user: "0:0"
    deploy:
      replicas: 2
    env_file:
      - .env
    environment:
      PORT: "8008"
      KORTIX_URL: http://api:8008
      LLM_GATEWAY_ENABLED: "true"
      LLM_GATEWAY_BASE_URL: http://gateway:8090/v1/llm
    expose:
      - "8008"
${APP_HEALTHCHECK('8008', '/v1/health')}
    restart: always
${LOG_LIMITS}

  gateway:
    image: \${KORTIX_GATEWAY_IMAGE}
    env_file:
      - .env
    environment:
      PORT: "8090"
      KORTIX_API_URL: http://api:8008
    expose:
      - "8090"
${APP_HEALTHCHECK('8090', '/')}
    restart: always
${LOG_LIMITS}

  frontend:
    image: \${KORTIX_FRONTEND_IMAGE}
    env_file:
      - .env
    environment:
      PORT: "3000"
      NODE_OPTIONS: "--max-http-header-size=131072"
    expose:
      - "3000"
${APP_HEALTHCHECK('3000', '/')}
    restart: always
${LOG_LIMITS}
`;
}

/**
 * Caddy routing table (spec §"Caddy owns what the ALB owned"). api runs multiple
 * replicas — the `dynamic a` upstream re-resolves the `api` service name every
 * few seconds so new replicas join and removed ones leave rotation, and passive
 * `fail_duration` ejects a wedged replica automatically. ACME is parameterized:
 * install writes acme.caddy (Route53 DNS-01 on AWS, empty → HTTP-01 elsewhere).
 */
function appCaddyfile(): string {
  return `{
	email {$KORTIX_ACME_EMAIL}
	import /etc/caddy/acme.caddy
}

# api.<domain>: /v1/llm* → gateway:8090, everything else → api:8008 (2+ replicas)
{$KORTIX_API_DOMAIN} {
	@llm path /v1/llm*
	handle @llm {
		reverse_proxy gateway:8090 {
			fail_duration 10s
		}
	}
	handle {
		reverse_proxy {
			dynamic a {
				name api
				port 8008
				refresh 5s
			}
			lb_policy round_robin
			fail_duration 15s
			health_uri /v1/health
			health_interval 10s
			health_timeout 5s
		}
	}
}

# <domain>: the six Supabase data-plane prefixes → Kong, everything else → frontend
{$KORTIX_FRONTEND_DOMAIN} {
	@supabase path /rest/v1* /auth/v1* /storage/v1* /realtime/v1* /functions/v1* /graphql/v1*
	handle @supabase {
		reverse_proxy {$KORTIX_SUPABASE_KONG_ORIGIN} {
			fail_duration 10s
		}
	}
	handle {
		reverse_proxy frontend:3000 {
			fail_duration 10s
		}
	}
}
`;
}

function appInstallScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'umask 077',
    '',
    'release=',
    'runtime_env=',
    'registry=',
    'api_image=',
    'gateway_image=',
    'frontend_image=',
    'caddy_image=',
    'api_domain=',
    'frontend_domain=',
    'acme_provider=http',
    'acme_email=',
    'route53_hosted_zone=',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --release) release="${2:-}"; shift 2 ;;',
    '    --runtime-env) runtime_env="${2:-}"; shift 2 ;;',
    '    --api-image) api_image="${2:-}"; shift 2 ;;',
    '    --gateway-image) gateway_image="${2:-}"; shift 2 ;;',
    '    --frontend-image) frontend_image="${2:-}"; shift 2 ;;',
    '    --caddy-image) caddy_image="${2:-}"; shift 2 ;;',
    '    --api-domain) api_domain="${2:-}"; shift 2 ;;',
    '    --frontend-domain) frontend_domain="${2:-}"; shift 2 ;;',
    '    --acme-provider) acme_provider="${2:-}"; shift 2 ;;',
    '    --acme-email) acme_email="${2:-}"; shift 2 ;;',
    '    --route53-hosted-zone) route53_hosted_zone="${2:-}"; shift 2 ;;',
    '    *) echo "unsupported app install option: $1" >&2; exit 2 ;;',
    '  esac',
    'done',
    'for value in "$release" "$runtime_env" "$api_image" "$gateway_image" "$frontend_image" "$caddy_image" "$api_domain" "$frontend_domain"; do',
    '  [ -n "$value" ] || { echo "missing required app install option" >&2; exit 2; }',
    'done',
    'root=$(readlink -f "$(dirname -- "${BASH_SOURCE[0]}")/..")',
    'test -f "$runtime_env"',
    '# The Supabase Kong origin the app + Caddy reach is the runtime SUPABASE_URL',
    '# (same box, private origin). Derived here so no extra install coordinate is needed.',
    'supabase_kong_origin=$(jq -r \'.SUPABASE_URL // ""\' "$runtime_env")',
    'case "$supabase_kong_origin" in http://*|https://*) ;; *) echo "runtime env SUPABASE_URL must be an http(s) origin" >&2; exit 1 ;; esac',
    '',
    '# Self-consistency: the signed descriptor must match this release and lock every app image digest.',
    'jq -e --arg release "$release" \'.schema_version == 1 and .kind == "kortix-enterprise-app" and .version == $release and (.compose_files == ["docker-compose.yml"]) and (.persistent_paths.caddy == "/var/lib/kortix/caddy") and (.image_digests | type == "object" and (keys == ["api","frontend","gateway"]) and all(.[]; test("^sha256:[a-f0-9]{64}$")))\' "$root/bundle.json" >/dev/null',
    '',
    '# Each provided app image must end in the exact locked digest; Caddy must be digest-pinned.',
    'for role in api gateway frontend; do',
    '  case "$role" in api) ref="$api_image" ;; gateway) ref="$gateway_image" ;; frontend) ref="$frontend_image" ;; esac',
    '  locked=$(jq -r --arg role "$role" \'.image_digests[$role]\' "$root/bundle.json")',
    '  case "$ref" in *"@$locked") ;; *) echo "$role image $ref does not match the signed digest $locked" >&2; exit 1 ;; esac',
    'done',
    'case "$caddy_image" in *@sha256:*) : ;; *) echo "Caddy image must be digest-pinned" >&2; exit 1 ;; esac',
    '',
    'for domain in "$api_domain" "$frontend_domain"; do',
    '  printf \'%s\' "$domain" | grep -Eq \'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$\' || { echo "unsafe app domain: $domain" >&2; exit 1; }',
    'done',
    '',
    'jq -e \'type == "object"\' >/dev/null <"$runtime_env"',
    '# Render .env: every string value from the runtime env, plus the pinned image',
    '# refs and the Caddy routing/ACME parameters. 0600, root-only.',
    'jq -r --arg api "$api_image" --arg gateway "$gateway_image" --arg frontend "$frontend_image" --arg caddy "$caddy_image" --arg api_domain "$api_domain" --arg frontend_domain "$frontend_domain" --arg kong "$supabase_kong_origin" --arg acme_email "$acme_email" \\',
    '  \'(with_entries(select(.value | type == "string")) + {KORTIX_API_IMAGE:$api, KORTIX_GATEWAY_IMAGE:$gateway, KORTIX_FRONTEND_IMAGE:$frontend, KORTIX_CADDY_IMAGE:$caddy, KORTIX_API_DOMAIN:$api_domain, KORTIX_FRONTEND_DOMAIN:$frontend_domain, KORTIX_SUPABASE_KONG_ORIGIN:$kong, KORTIX_ACME_EMAIL:$acme_email}) | to_entries | sort_by(.key)[] | "\\(.key)=\\(.value | @json)"\' <"$runtime_env" >"$root/.env"',
    'chmod 0600 "$root/.env"',
    '',
    '# ACME provider snippet imported by the Caddyfile globals (runtime, not signed).',
    'if [ "$acme_provider" = "route53" ]; then',
    '  { echo "acme_dns route53 {"; [ -n "$route53_hosted_zone" ] && printf \'\\thosted_zone %s\\n\' "$route53_hosted_zone"; echo "}"; } >"$root/acme.caddy"',
    'else',
    '  echo "# HTTP-01 challenge (no DNS provider configured)" >"$root/acme.caddy"',
    'fi',
    'chmod 0644 "$root/acme.caddy"',
    '',
    'install -d -m 0700 /var/lib/kortix/caddy',
    '',
    'compose=(docker compose --project-name kortix-app --env-file "$root/.env" -f "$root/docker-compose.yml")',
    '"${compose[@]}" config --quiet',
    '# Every configured app image must resolve to a locked digest (Caddy excepted — pinned above).',
    'mapfile -t configured_images < <("${compose[@]}" config --images | sort -u)',
    'for image in "${configured_images[@]}"; do',
    '  case "$image" in',
    '    "$caddy_image") ;;',
    '    *@sha256:*)',
    '      locked=0',
    '      for role in api gateway frontend; do',
    '        digest=$(jq -r --arg role "$role" \'.image_digests[$role]\' "$root/bundle.json")',
    '        case "$image" in *"@$digest") locked=1 ;; esac',
    '      done',
    '      [ "$locked" = 1 ] || { echo "app Compose image $image is not in the signed digest lock" >&2; exit 1; } ;;',
    '    *) echo "app Compose image $image is not digest-pinned" >&2; exit 1 ;;',
    '  esac',
    'done',
    '',
    '# The app bundle owns its own systemd units (user-data seeds only',
    '# kortix-supabase.service). Install + enable them; enable-only kortix-app so a',
    '# reboot brings the stack up, but leave the running containers to the updater',
    '# roll — do NOT --now it here.',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  for unit in "$root/systemd"/*.service "$root/systemd"/*.timer; do',
    '    [ -e "$unit" ] || continue',
    '    install -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"',
    '  done',
    '  systemctl daemon-reload',
    '  systemctl enable kortix-app.service >/dev/null 2>&1 || true',
    '  systemctl enable --now kortix-updater.timer kortix-watchdog.timer kortix-prune.timer >/dev/null 2>&1 || true',
    'fi',
    '',
  ].join('\n');
}

function appStartScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'root=$(readlink -f "$(dirname -- "${BASH_SOURCE[0]}")/..")',
    'compose=(docker compose --project-name kortix-app --env-file "$root/.env" -f "$root/docker-compose.yml")',
    '"${compose[@]}" up --detach --remove-orphans --wait --wait-timeout 600',
    '',
  ].join('\n');
}

function appStopScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'root=$(readlink -f "$(dirname -- "${BASH_SOURCE[0]}")/..")',
    'exec docker compose --project-name kortix-app --env-file "$root/.env" -f "$root/docker-compose.yml" down --timeout 60',
    '',
  ].join('\n');
}

/**
 * ~40-line watchdog: curls the local health endpoints (api + frontend via Caddy
 * on loopback, Kong directly) and restarts kortix-app after N consecutive
 * failures, with a cooldown so it can't flap. It NEVER acts during an updater run
 * — it takes the same flock the updater holds and exits immediately if it can't.
 */
function appWatchdogScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `LOCK=${UPDATER_LOCK}`,
    'STATE=/var/lib/kortix/watchdog.fails',
    'COOLDOWN_FILE=/var/lib/kortix/watchdog.last-restart',
    'ENV_FILE=/opt/kortix/app/.env',
    'THRESHOLD=3',
    'COOLDOWN=600',
    'install -d -m 0700 /var/lib/kortix',
    'exec 9>"$LOCK" || exit 0',
    '# An updater run holds this lock; never restart mid-deploy.',
    'flock -n 9 || exit 0',
    '[ -r "$ENV_FILE" ] || exit 0',
    'val() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e \'s/^"//\' -e \'s/"$//\'; }',
    'api_domain=$(val KORTIX_API_DOMAIN)',
    'frontend_domain=$(val KORTIX_FRONTEND_DOMAIN)',
    'anon=$(val ANON_KEY)',
    'ok=1',
    'check() { curl -fsS --max-time 5 "$@" >/dev/null 2>&1 || ok=0; }',
    'reachable() { code=$(curl -s -o /dev/null --max-time 5 -w "%{http_code}" "$@" 2>/dev/null); { [ -n "$code" ] && [ "$code" != 000 ]; } || ok=0; }',
    '[ -n "$api_domain" ] && check --resolve "$api_domain:443:127.0.0.1" "https://$api_domain/v1/health"',
    '[ -n "$api_domain" ] && reachable --resolve "$api_domain:443:127.0.0.1" "https://$api_domain/v1/llm"',
    '[ -n "$frontend_domain" ] && reachable --resolve "$frontend_domain:443:127.0.0.1" "https://$frontend_domain/"',
    '[ -n "$anon" ] && check --header "apikey: $anon" "http://127.0.0.1:8000/auth/v1/health"',
    'if [ "$ok" = 1 ]; then echo 0 >"$STATE"; exit 0; fi',
    'fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))',
    'echo "$fails" >"$STATE"',
    '[ "$fails" -ge "$THRESHOLD" ] || exit 0',
    'now=$(date +%s); last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)',
    '[ $(( now - last )) -ge "$COOLDOWN" ] || exit 0',
    'echo "$now" >"$COOLDOWN_FILE"',
    'echo 0 >"$STATE"',
    'echo "kortix-watchdog: health checks failed ${fails}x; restarting kortix-app.service" >&2',
    'systemctl restart kortix-app.service',
    '',
  ].join('\n');
}

function appPruneScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `LOCK=${UPDATER_LOCK}`,
    'install -d -m 0700 /var/lib/kortix',
    'exec 9>"$LOCK" || exit 0',
    '# Do not prune during an update (images being pulled/rolled hold the lock).',
    'flock -n 9 || exit 0',
    '# Reclaim dangling images/build cache from repeated updates — the #1 disk killer.',
    'docker image prune --all --force --filter "until=168h" >/dev/null 2>&1 || true',
    'docker builder prune --force --filter "unused-for=168h" >/dev/null 2>&1 || true',
    'docker container prune --force >/dev/null 2>&1 || true',
    '',
  ].join('\n');
}

function systemdUnits(): Record<string, string> {
  return {
    'kortix-app.service': `[Unit]
Description=Kortix enterprise application stack (Caddy + api + gateway + frontend)
Requires=docker.service
After=docker.service network-online.target kortix-supabase.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/kortix/app/bin/app-start
ExecStop=/opt/kortix/app/bin/app-stop
Restart=on-failure
RestartSec=15
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
`,
    'kortix-updater.service': `[Unit]
Description=Kortix enterprise updater (TUF-verified deploy/reconcile)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/kortix/bin/kortix-updater run
TimeoutStartSec=3600
`,
    'kortix-updater.timer': `[Unit]
Description=Daily Kortix enterprise update check

[Timer]
OnCalendar=daily
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
`,
    'kortix-watchdog.service': `[Unit]
Description=Kortix appliance health watchdog
After=kortix-app.service

[Service]
Type=oneshot
ExecStart=/opt/kortix/app/bin/watchdog
`,
    'kortix-watchdog.timer': `[Unit]
Description=Run the Kortix health watchdog every few minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
`,
    'kortix-prune.service': `[Unit]
Description=Kortix appliance Docker prune (reclaim dangling images/cache)
After=docker.service

[Service]
Type=oneshot
ExecStart=/opt/kortix/app/bin/prune
`,
    'kortix-prune.timer': `[Unit]
Description=Weekly Docker prune to keep the single box from filling up

[Timer]
OnCalendar=weekly
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

function writeExecutable(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o755 });
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o755 });
  chmodSync(path, 0o755);
}

function enterpriseSupabaseOverlay(): string {
  return `services:
  supavisor:
    ulimits:
      nofile:
        soft: 100000
        hard: 100000
`;
}

function supabaseHostInstallScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'umask 077',
    '',
    'runtime_secret_arn=',
    'release=',
    'instance=',
    'api_domain=',
    'frontend_domain=',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --runtime-secret-arn) runtime_secret_arn="${2:-}"; shift 2 ;;',
    '    --release) release="${2:-}"; shift 2 ;;',
    '    --instance) instance="${2:-}"; shift 2 ;;',
    '    --api-domain) api_domain="${2:-}"; shift 2 ;;',
    '    --frontend-domain) frontend_domain="${2:-}"; shift 2 ;;',
    '    *) echo "unsupported install option: $1" >&2; exit 2 ;;',
    '  esac',
    'done',
    'for value in "$runtime_secret_arn" "$release" "$instance" "$api_domain" "$frontend_domain"; do',
    '  [ -n "$value" ] || { echo "missing required Supabase install option" >&2; exit 2; }',
    'done',
    'root=$(readlink -f "$(dirname -- "${BASH_SOURCE[0]}")/..")',
    '',
    'jq -e --arg release "$release" \'.schema_version == 1 and .kind == "kortix-enterprise-supabase" and .version == $release and (.compose_files == ["docker-compose.yml", "docker-compose.logs.yml", "docker-compose.enterprise.yml"]) and (.persistent_paths["volumes/db/data"] == "/var/lib/kortix/postgres") and (.persistent_paths["volumes/storage"] == "/var/lib/kortix/storage") and (.image_digests | type == "object" and length > 0 and all(to_entries[]; (.key | type == "string") and (.value | test("^sha256:[a-f0-9]{64}$"))))\' "$root/bundle.json" >/dev/null',
    '',
    'secret_json=$(aws secretsmanager get-secret-value --secret-id "$runtime_secret_arn" --query SecretString --output text)',
    'jq -e \'type == "object"\' >/dev/null <<<"$secret_json"',
    'required=(POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY DASHBOARD_PASSWORD SECRET_KEY_BASE REALTIME_DB_ENC_KEY VAULT_ENC_KEY PG_META_CRYPTO_KEY LOGFLARE_PUBLIC_ACCESS_TOKEN LOGFLARE_PRIVATE_ACCESS_TOKEN S3_PROTOCOL_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET POOLER_TENANT_ID SMTP_ADMIN_EMAIL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_SENDER_NAME)',
    'for key in "${required[@]}"; do',
    '  jq -e --arg key "$key" \'.[$key] | type == "string" and length > 0\' >/dev/null <<<"$secret_json" || { echo "runtime secret is missing $key" >&2; exit 1; }',
    'done',
    'jq -e \'.POSTGRES_PASSWORD | length >= 32\' >/dev/null <<<"$secret_json" || { echo "POSTGRES_PASSWORD must be at least 32 characters" >&2; exit 1; }',
    'jq -e \'.JWT_SECRET | length >= 32\' >/dev/null <<<"$secret_json" || { echo "JWT_SECRET must be at least 32 characters" >&2; exit 1; }',
    'jq -e \'.SECRET_KEY_BASE | length >= 64\' >/dev/null <<<"$secret_json" || { echo "SECRET_KEY_BASE must be at least 64 characters" >&2; exit 1; }',
    'jq -e \'.REALTIME_DB_ENC_KEY | length == 16\' >/dev/null <<<"$secret_json" || { echo "REALTIME_DB_ENC_KEY must be exactly 16 characters" >&2; exit 1; }',
    'jq -e \'.VAULT_ENC_KEY | length == 32\' >/dev/null <<<"$secret_json" || { echo "VAULT_ENC_KEY must be exactly 32 characters" >&2; exit 1; }',
    '',
    'allowed=\'["POSTGRES_PASSWORD","JWT_SECRET","ANON_KEY","SERVICE_ROLE_KEY","SUPABASE_PUBLISHABLE_KEY","SUPABASE_SECRET_KEY","JWT_KEYS","JWT_JWKS","DASHBOARD_USERNAME","DASHBOARD_PASSWORD","SECRET_KEY_BASE","REALTIME_DB_ENC_KEY","VAULT_ENC_KEY","PG_META_CRYPTO_KEY","LOGFLARE_PUBLIC_ACCESS_TOKEN","LOGFLARE_PRIVATE_ACCESS_TOKEN","S3_PROTOCOL_ACCESS_KEY_ID","S3_PROTOCOL_ACCESS_KEY_SECRET","POOLER_TENANT_ID","OPENAI_API_KEY","SMTP_ADMIN_EMAIL","SMTP_HOST","SMTP_PORT","SMTP_USER","SMTP_PASS","SMTP_SENDER_NAME","ENABLE_EMAIL_SIGNUP","ENABLE_EMAIL_AUTOCONFIRM","ENABLE_ANONYMOUS_USERS","ENABLE_PHONE_SIGNUP","ENABLE_PHONE_AUTOCONFIRM","DISABLE_SIGNUP"]\'',
    'defaults=\'{"COMPOSE_FILE":"docker-compose.yml:docker-compose.logs.yml","POSTGRES_HOST":"db","POSTGRES_DB":"postgres","POSTGRES_PORT":"5432","POOLER_PROXY_PORT_TRANSACTION":"6543","POOLER_DEFAULT_POOL_SIZE":"20","POOLER_MAX_CLIENT_CONN":"100","POOLER_DB_POOL_SIZE":"5","STUDIO_DEFAULT_ORGANIZATION":"Kortix","STUDIO_DEFAULT_PROJECT":"Kortix Enterprise","JWT_EXPIRY":"3600","MAILER_URLPATHS_CONFIRMATION":"/auth/v1/verify","MAILER_URLPATHS_INVITE":"/auth/v1/verify","MAILER_URLPATHS_RECOVERY":"/auth/v1/verify","MAILER_URLPATHS_EMAIL_CHANGE":"/auth/v1/verify","GLOBAL_S3_BUCKET":"stub","REGION":"stub","STORAGE_TENANT_ID":"kortix","FUNCTIONS_VERIFY_JWT":"false","PGRST_DB_SCHEMAS":"public,graphql_public","PGRST_DB_MAX_ROWS":"1000","PGRST_DB_EXTRA_SEARCH_PATH":"public","DOCKER_SOCKET_LOCATION":"/var/run/docker.sock","KONG_HTTP_PORT":"8000","KONG_HTTPS_PORT":"8443","IMGPROXY_AUTO_WEBP":"true","DASHBOARD_USERNAME":"kortix"}\'',
    '# The ALB serves the Supabase data-plane (/rest, /auth, /storage, …) on the',
    '# frontend/root host, so the GoTrue public + external URLs use the frontend',
    '# origin; email links and the token issuer resolve back through the ALB.',
    'jq -r --argjson allowed "$allowed" --argjson defaults "$defaults" --arg supabase_url "https://$frontend_domain" --arg site_url "https://$frontend_domain" \'. as $secret | ($defaults + ($secret | with_entries(select(.key as $key | $allowed | index($key)))) + {SUPABASE_PUBLIC_URL:$supabase_url, API_EXTERNAL_URL:($supabase_url + "/auth/v1"), SITE_URL:$site_url, ADDITIONAL_REDIRECT_URLS:($site_url + "/**")}) | to_entries | sort_by(.key)[] | select(.value | type == "string") | "\\(.key)=\\(.value | @json)"\' <<<"$secret_json" >"$root/.env"',
    'chmod 0600 "$root/.env"',
    'printf "%s\\n" "$instance" >"$root/.instance"',
    'chmod 0600 "$root/.instance"',
    '',
    'install -d -m 0700 /var/lib/kortix/postgres /var/lib/kortix/storage',
    'for mapping in "volumes/db/data:/var/lib/kortix/postgres" "volumes/storage:/var/lib/kortix/storage"; do',
    '  relative=${mapping%%:*}',
    '  target=${mapping#*:}',
    '  path="$root/$relative"',
    '  if [ -L "$path" ]; then rm -f "$path"; elif [ -e "$path" ]; then',
    '    [ -d "$path" ] || { echo "$relative must be a directory" >&2; exit 1; }',
    '    [ -z "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ] || { echo "$relative in a release bundle must be empty" >&2; exit 1; }',
    '    rmdir "$path"',
    '  fi',
    '  ln -s "$target" "$path"',
    'done',
    '',
    'compose=(docker compose --project-name "kortix-$instance" --env-file "$root/.env" -f "$root/docker-compose.yml" -f "$root/docker-compose.logs.yml" -f "$root/docker-compose.enterprise.yml")',
    '"${compose[@]}" config --quiet',
    'mapfile -t configured_images < <("${compose[@]}" config --images | sort -u)',
    'mapfile -t locked_images < <(jq -r \'.image_digests | to_entries[] | "\\(.key)@\\(.value)"\' "$root/bundle.json" | sort -u)',
    '[ "${configured_images[*]}" = "${locked_images[*]}" ] || { echo "Supabase Compose images do not match the signed immutable image lock" >&2; exit 1; }',
    '"${compose[@]}" pull',
    '',
  ].join('\n');
}

function supabaseStartScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'root=$(readlink -f "$(dirname -- "${BASH_SOURCE[0]}")/..")',
    'instance=$(<"$root/.instance")',
    'compose=(docker compose --project-name "kortix-$instance" --env-file "$root/.env" -f "$root/docker-compose.yml" -f "$root/docker-compose.logs.yml" -f "$root/docker-compose.enterprise.yml")',
    '"${compose[@]}" up --detach --remove-orphans --wait --wait-timeout 900',
    'anon_key=$(docker inspect supabase-kong --format \'{{range .Config.Env}}{{println .}}{{end}}\' | sed -n \'s/^SUPABASE_ANON_KEY=//p\')',
    '[ -n "$anon_key" ] || { echo "Supabase Kong anonymous key is unavailable" >&2; exit 1; }',
    'curl --fail --silent --show-error --max-time 10 --header "apikey: $anon_key" http://127.0.0.1:8000/auth/v1/health >/dev/null',
    'unset anon_key',
    '',
  ].join('\n');
}

function supabaseStopScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'root=$(readlink -f "$(dirname -- "${BASH_SOURCE[0]}")/..")',
    'instance=$(<"$root/.instance")',
    'exec docker compose --project-name "kortix-$instance" --env-file "$root/.env" -f "$root/docker-compose.yml" -f "$root/docker-compose.logs.yml" -f "$root/docker-compose.enterprise.yml" down --timeout 120',
    '',
  ].join('\n');
}

