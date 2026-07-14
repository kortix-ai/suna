import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

export interface PlatformBundleDescriptor {
  schema_version: 1;
  kind: 'kortix-enterprise-platform';
  version: string;
  terraform_root: 'terraform/environments/enterprise-vpc-template/platform';
  charts: {
    api: 'charts/kortix-api';
    gateway: 'charts/kortix-gateway';
    edge: 'charts/kortix-enterprise-edge';
  };
  namespace: 'kortix-app';
  deployments: ['kortix-api', 'kortix-gateway', 'kortix-frontend'];
}

const ENTERPRISE_VERSION = /^\d+\.\d+\.\d+-e[1-9]\d*$/;

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

export function materializePlatformBundle(
  root: string,
  version: string,
  repositoryRoot = resolve(import.meta.dir, '..', '..', '..'),
): PlatformBundleDescriptor {
  if (!ENTERPRISE_VERSION.test(version)) {
    throw new Error('enterprise bundle version must use <prod-version>-e<revision>');
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const copies: Array<[string, string]> = [
    [
      'infra/terraform/environments/enterprise-vpc-template/platform',
      'terraform/environments/enterprise-vpc-template/platform',
    ],
    ['infra/terraform/modules/enterprise-platform', 'terraform/modules/enterprise-platform'],
    ['infra/terraform/modules/eks/platform', 'terraform/modules/eks/platform'],
    ['infra/terraform/modules/eks/irsa', 'terraform/modules/eks/irsa'],
    ['infra/k8s/charts/kortix-api', 'charts/kortix-api'],
    ['infra/k8s/charts/kortix-gateway', 'charts/kortix-gateway'],
    ['infra/k8s/charts/kortix-enterprise-edge', 'charts/kortix-enterprise-edge'],
  ];
  for (const [source, destination] of copies) {
    cpSync(join(repositoryRoot, source), join(root, destination), {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (path) => !path.split('/').includes('.terraform'),
    });
  }

  const descriptor: PlatformBundleDescriptor = {
    schema_version: 1,
    kind: 'kortix-enterprise-platform',
    version,
    terraform_root: 'terraform/environments/enterprise-vpc-template/platform',
    charts: {
      api: 'charts/kortix-api',
      gateway: 'charts/kortix-gateway',
      edge: 'charts/kortix-enterprise-edge',
    },
    namespace: 'kortix-app',
    deployments: ['kortix-api', 'kortix-gateway', 'kortix-frontend'],
  };
  writeFileSync(join(root, 'bundle.json'), `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  return descriptor;
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
    'jq -r --argjson allowed "$allowed" --argjson defaults "$defaults" --arg supabase_url "https://$api_domain" --arg site_url "https://$frontend_domain" \'. as $secret | ($defaults + ($secret | with_entries(select(.key as $key | $allowed | index($key)))) + {SUPABASE_PUBLIC_URL:$supabase_url, API_EXTERNAL_URL:($supabase_url + "/auth/v1"), SITE_URL:$site_url, ADDITIONAL_REDIRECT_URLS:($site_url + "/**")}) | to_entries | sort_by(.key)[] | select(.value | type == "string") | "\\(.key)=\\(.value | @json)"\' <<<"$secret_json" >"$root/.env"',
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

