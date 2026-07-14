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
    wal_spool: '/var/lib/kortix/wal';
    recovery_wal: '/var/lib/kortix/recovery-wal';
  };
  image_digests: Record<string, string>;
  backup: {
    archive_timeout_seconds: 300;
    wal_upload_interval_seconds: 60;
    base_backup_interval: 'daily';
  };
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
  };
  writeFileSync(join(root, 'bundle.json'), `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  writeExecutable(join(root, 'bin', 'install'), supabaseHostInstallScript());
  writeExecutable(join(root, 'bin', 'supabase-start'), supabaseStartScript());
  writeExecutable(join(root, 'bin', 'supabase-stop'), supabaseStopScript());
  writeExecutable(join(root, 'bin', 'wal-archive'), walArchiveScript());
  writeExecutable(join(root, 'bin', 'base-backup'), baseBackupScript());
  writeExecutable(join(root, 'bin', 'pitr-restore'), pitrRestoreScript());
  writeSystemdUnit(root, 'kortix-wal-archive.service', walArchiveService());
  writeSystemdUnit(root, 'kortix-wal-archive.timer', walArchiveTimer());
  writeSystemdUnit(root, 'kortix-base-backup.service', baseBackupService());
  writeSystemdUnit(root, 'kortix-base-backup.timer', baseBackupTimer());
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

function writeSystemdUnit(root: string, name: string, content: string): void {
  const path = join(root, 'systemd', name);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o755 });
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o644 });
}

function enterpriseSupabaseOverlay(): string {
  return `services:
  db:
    volumes:
      - /var/lib/kortix/wal:/var/lib/kortix-wal:Z
      - /var/lib/kortix/recovery-wal:/var/lib/kortix-recovery-wal:ro,Z
    command:
      - postgres
      - -c
      - config_file=/etc/postgresql/postgresql.conf
      - -c
      - log_min_messages=fatal
      - -c
      - archive_mode=on
      - -c
      - archive_timeout=300s
      - -c
      - archive_command=cp %p /var/lib/kortix-wal/.%f.tmp && mv /var/lib/kortix-wal/.%f.tmp /var/lib/kortix-wal/%f
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
    'jq -e --arg release "$release" \'.schema_version == 1 and .kind == "kortix-enterprise-supabase" and .version == $release and (.compose_files == ["docker-compose.yml", "docker-compose.logs.yml", "docker-compose.enterprise.yml"]) and (.persistent_paths["volumes/db/data"] == "/var/lib/kortix/postgres") and (.persistent_paths["volumes/storage"] == "/var/lib/kortix/storage") and (.persistent_paths.wal_spool == "/var/lib/kortix/wal") and (.persistent_paths.recovery_wal == "/var/lib/kortix/recovery-wal") and (.backup == {archive_timeout_seconds:300,wal_upload_interval_seconds:60,base_backup_interval:"daily"}) and (.image_digests | type == "object" and length > 0 and all(to_entries[]; (.key | type == "string") and (.value | test("^sha256:[a-f0-9]{64}$"))))\' "$root/bundle.json" >/dev/null',
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
    'install -d -m 0700 /var/lib/kortix/postgres /var/lib/kortix/storage /var/lib/kortix/wal /var/lib/kortix/recovery-wal /var/lib/kortix/restores',
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
    'db_image=$(printf "%s\\n" "${configured_images[@]}" | grep -E "^supabase/postgres:.*@sha256:[a-f0-9]{64}$")',
    'docker run --rm --user 0:0 --entrypoint sh -v /var/lib/kortix/wal:/wal:Z "$db_image" -c \"chown \\\"\\$(id -u postgres):\\$(id -g postgres)\\\" /wal && chmod 0700 /wal\"',
    'install -m 0644 "$root"/systemd/kortix-wal-archive.service "$root"/systemd/kortix-wal-archive.timer "$root"/systemd/kortix-base-backup.service "$root"/systemd/kortix-base-backup.timer /etc/systemd/system/',
    'systemctl daemon-reload',
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
    'systemctl enable --now kortix-wal-archive.timer kortix-base-backup.timer',
    'systemctl start kortix-wal-archive.service',
    '',
  ].join('\n');
}

function supabaseStopScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'root=$(readlink -f "$(dirname -- "${BASH_SOURCE[0]}")/..")',
    'instance=$(<"$root/.instance")',
    'systemctl stop kortix-wal-archive.timer kortix-base-backup.timer || true',
    'exec docker compose --project-name "kortix-$instance" --env-file "$root/.env" -f "$root/docker-compose.yml" -f "$root/docker-compose.logs.yml" -f "$root/docker-compose.enterprise.yml" down --timeout 120',
    '',
  ].join('\n');
}

function walArchiveScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'umask 077',
    'source "${KORTIX_INSTANCE_ENV_FILE:-/etc/kortix/instance.env}"',
    ': "${AWS_REGION:?}" "${KORTIX_INSTANCE:?}" "${KORTIX_BACKUP_BUCKET:?}" "${KORTIX_BACKUP_KMS_KEY_ARN:?}" "${KORTIX_STATE_TABLE:?}"',
    'lock_dir=${KORTIX_BACKUP_LOCK_DIR:-/run/lock}',
    'install -d -m 0755 "$lock_dir"',
    'exec 9>"$lock_dir/kortix-wal-archive.lock"',
    'flock -n 9 || exit 0',
    'shopt -s nullglob',
    'spool=${KORTIX_WAL_SPOOL:-/var/lib/kortix/wal}',
    'latest_name=',
    'for path in "$spool"/*; do',
    '  [ -f "$path" ] && [ ! -L "$path" ] || continue',
    '  name=${path##*/}',
    '  [[ "$name" =~ ^[0-9A-F]{24}(\\.partial|\\.[0-9A-F]{8}\\.backup)?$ || "$name" =~ ^[0-9A-F]{8}\\.history$ ]] || { echo "refusing unexpected WAL spool file: $name" >&2; exit 1; }',
    '  destination="s3://$KORTIX_BACKUP_BUCKET/wal/$KORTIX_INSTANCE/$name"',
    '  aws s3 cp "$path" "$destination" --region "$AWS_REGION" --sse aws:kms --sse-kms-key-id "$KORTIX_BACKUP_KMS_KEY_ARN" --only-show-errors',
    '  expected=$(stat -c %s "$path")',
    '  actual=$(aws s3api head-object --bucket "$KORTIX_BACKUP_BUCKET" --key "wal/$KORTIX_INSTANCE/$name" --region "$AWS_REGION" --query ContentLength --output text)',
    '  [ "$actual" = "$expected" ] || { echo "uploaded WAL length mismatch for $name" >&2; exit 1; }',
    '  rm -f -- "$path"',
    '  latest_name=$name',
    'done',
    'if [ -n "$latest_name" ]; then',
    '  archived_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    '  values=$(jq -cn --arg archived_at "$archived_at" --arg name "$latest_name" \'{":archived_at":{S:$archived_at},":name":{S:$name}}\')',
    '  aws dynamodb update-item --table-name "$KORTIX_STATE_TABLE" --key "{\\"instance\\":{\\"S\\":\\"$KORTIX_INSTANCE\\"}}" --update-expression "SET last_wal_archived_at = :archived_at, last_wal_name = :name" --expression-attribute-values "$values" --region "$AWS_REGION" --output json >/dev/null',
    'fi',
    '',
  ].join('\n');
}

function baseBackupScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'umask 077',
    'source "${KORTIX_INSTANCE_ENV_FILE:-/etc/kortix/instance.env}"',
    ': "${AWS_REGION:?}" "${KORTIX_INSTANCE:?}" "${KORTIX_BACKUP_BUCKET:?}" "${KORTIX_BACKUP_KMS_KEY_ARN:?}" "${KORTIX_STATE_TABLE:?}"',
    'lock_dir=${KORTIX_BACKUP_LOCK_DIR:-/run/lock}',
    'install -d -m 0755 "$lock_dir"',
    'exec 9>"$lock_dir/kortix-base-backup.lock"',
    'flock -n 9 || exit 0',
    'stamp=$(date -u +%Y%m%dT%H%M%SZ)',
    'prefix="basebackups/$KORTIX_INSTANCE/$stamp"',
    'key="$prefix/base.tar.gz"',
    'docker exec supabase-db sh -ceu \'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_basebackup --host 127.0.0.1 --username postgres --pgdata - --format tar --gzip --wal-method stream --checkpoint fast --no-password\' | aws s3 cp - "s3://$KORTIX_BACKUP_BUCKET/$key" --region "$AWS_REGION" --sse aws:kms --sse-kms-key-id "$KORTIX_BACKUP_KMS_KEY_ARN" --checksum-algorithm SHA256 --only-show-errors',
    'head=$(aws s3api head-object --bucket "$KORTIX_BACKUP_BUCKET" --key "$key" --checksum-mode ENABLED --region "$AWS_REGION")',
    'size=$(jq -er \'.ContentLength | numbers | select(. > 0)\' <<<"$head")',
    'checksum=$(jq -er \'.ChecksumSHA256 | strings | select(length > 0)\' <<<"$head")',
    'manifest=$(jq -cn --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg checksum_sha256 "$checksum" --arg instance "$KORTIX_INSTANCE" --arg object_key "$key" --argjson length "$size" \'{schema_version:1,instance:$instance,created_at:$created_at,object_key:$object_key,checksum_sha256:$checksum_sha256,length:$length}\')',
    'aws s3 cp - "s3://$KORTIX_BACKUP_BUCKET/$prefix/manifest.json" --region "$AWS_REGION" --content-type application/json --sse aws:kms --sse-kms-key-id "$KORTIX_BACKUP_KMS_KEY_ARN" --only-show-errors <<<"$manifest"',
    'created_at=$(jq -r .created_at <<<"$manifest")',
    'values=$(jq -cn --arg created_at "$created_at" --arg key "$key" \'{":created_at":{S:$created_at},":key":{S:$key}}\')',
    'aws dynamodb update-item --table-name "$KORTIX_STATE_TABLE" --key "{\\"instance\\":{\\"S\\":\\"$KORTIX_INSTANCE\\"}}" --update-expression "SET last_base_backup_at = :created_at, last_base_backup_key = :key" --expression-attribute-values "$values" --region "$AWS_REGION" --output json >/dev/null',
    '',
  ].join('\n');
}

function pitrRestoreScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'umask 077',
    'source "${KORTIX_INSTANCE_ENV_FILE:-/etc/kortix/instance.env}"',
    ': "${AWS_REGION:?}" "${KORTIX_INSTANCE:?}" "${KORTIX_BACKUP_BUCKET:?}" "${KORTIX_STATE_TABLE:?}"',
    '',
    'manifest_key=',
    'target_time=',
    'confirm_instance=',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --manifest-key) manifest_key="${2:-}"; shift 2 ;;',
    '    --target-time) target_time="${2:-}"; shift 2 ;;',
    '    --confirm-instance) confirm_instance="${2:-}"; shift 2 ;;',
    '    *) echo "unsupported PITR option: $1" >&2; exit 2 ;;',
    '  esac',
    'done',
    '[ "$confirm_instance" = "$KORTIX_INSTANCE" ] || { echo "--confirm-instance must exactly match $KORTIX_INSTANCE" >&2; exit 2; }',
    'expected_prefix="basebackups/$KORTIX_INSTANCE/"',
    '[[ "$manifest_key" =~ ^${expected_prefix}[0-9]{8}T[0-9]{6}Z/manifest\\.json$ ]] || { echo "manifest key is not a safe backup coordinate for $KORTIX_INSTANCE" >&2; exit 2; }',
    '[[ "$target_time" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "target time must be UTC RFC3339 seconds" >&2; exit 2; }',
    'target_epoch=$(date -u -d "$target_time" +%s) || { echo "invalid target time" >&2; exit 2; }',
    '[ "$target_epoch" -le "$(date -u +%s)" ] || { echo "target time cannot be in the future" >&2; exit 2; }',
    '',
    'root=$(readlink -f "$(dirname -- "${BASH_SOURCE[0]}")/..")',
    'bundle_instance=$(<"$root/.instance")',
    '[ "$bundle_instance" = "$KORTIX_INSTANCE" ] || { echo "active bundle instance does not match recovery instance" >&2; exit 1; }',
    'data_dir=${KORTIX_POSTGRES_DATA_DIR:-/var/lib/kortix/postgres}',
    'recovery_dir=${KORTIX_RECOVERY_WAL_DIR:-/var/lib/kortix/recovery-wal}',
    'restore_root=${KORTIX_RESTORE_WORK_DIR:-/var/lib/kortix/restores}',
    'lock_dir=${KORTIX_BACKUP_LOCK_DIR:-/run/lock}',
    'install -d -m 0700 "$restore_root"',
    'install -d -m 0755 "$lock_dir"',
    'exec 9>"$lock_dir/kortix-pitr-restore.lock"',
    'flock -n 9 || { echo "another backup or restore operation holds the PITR lock" >&2; exit 1; }',
    'stamp=$(date -u +%Y%m%dT%H%M%SZ)',
    'work="$restore_root/pitr-$stamp"',
    'install -d -m 0700 "$work/data" "$work/recovery-wal"',
    '',
    'aws s3 cp "s3://$KORTIX_BACKUP_BUCKET/$manifest_key" "$work/manifest.json" --region "$AWS_REGION" --only-show-errors',
    'base_key="${manifest_key%/manifest.json}/base.tar.gz"',
    'jq -e --arg instance "$KORTIX_INSTANCE" --arg key "$base_key" \'.schema_version == 1 and .instance == $instance and .object_key == $key and (.created_at | type == "string") and (.checksum_sha256 | type == "string" and length > 0) and (.length | type == "number" and . > 0) and ((keys - ["schema_version","instance","created_at","object_key","checksum_sha256","length"]) | length == 0)\' "$work/manifest.json" >/dev/null || { echo "backup manifest contract is invalid" >&2; exit 1; }',
    'created_at=$(jq -r .created_at "$work/manifest.json")',
    'created_epoch=$(date -u -d "$created_at" +%s) || { echo "backup manifest created_at is invalid" >&2; exit 1; }',
    '[ "$target_epoch" -ge "$created_epoch" ] || { echo "target time predates the completed base backup" >&2; exit 1; }',
    'aws s3 cp "s3://$KORTIX_BACKUP_BUCKET/$base_key" "$work/base.tar.gz" --region "$AWS_REGION" --only-show-errors',
    'expected_length=$(jq -r .length "$work/manifest.json")',
    'actual_length=$(stat -c %s "$work/base.tar.gz")',
    '[ "$actual_length" = "$expected_length" ] || { echo "downloaded base backup length mismatch" >&2; exit 1; }',
    'expected_checksum=$(jq -r .checksum_sha256 "$work/manifest.json")',
    'actual_checksum=$(openssl dgst -sha256 -binary "$work/base.tar.gz" | base64 | tr -d "\\n")',
    '[ "$actual_checksum" = "$expected_checksum" ] || { echo "downloaded base backup checksum mismatch" >&2; exit 1; }',
    'while IFS= read -r entry; do',
    '  case "$entry" in /*|../*|*/../*|*/..) echo "unsafe path in base backup: $entry" >&2; exit 1 ;; esac',
    'done < <(tar --list --gzip --file "$work/base.tar.gz")',
    'tar --extract --gzip --file "$work/base.tar.gz" --directory "$work/data" --no-same-owner --no-same-permissions',
    '[ -f "$work/data/PG_VERSION" ] || { echo "base backup does not contain PG_VERSION" >&2; exit 1; }',
    '',
    'aws s3 sync "s3://$KORTIX_BACKUP_BUCKET/wal/$KORTIX_INSTANCE/" "$work/recovery-wal/" --region "$AWS_REGION" --only-show-errors',
    'wal_count=0',
    'while IFS= read -r -d "" path; do',
    '  [ -f "$path" ] && [ ! -L "$path" ] || { echo "recovery WAL contains a non-regular file" >&2; exit 1; }',
    '  name=${path##*/}',
    '  [[ "$name" =~ ^[0-9A-F]{24}(\\.partial|\\.[0-9A-F]{8}\\.backup)?$ || "$name" =~ ^[0-9A-F]{8}\\.history$ ]] || { echo "recovery WAL contains an unexpected filename: $name" >&2; exit 1; }',
    '  wal_count=$((wal_count + 1))',
    'done < <(find "$work/recovery-wal" -mindepth 1 -maxdepth 1 -print0)',
    '[ "$wal_count" -gt 0 ] || { echo "no archived WAL is available for recovery" >&2; exit 1; }',
    'cat >>"$work/data/postgresql.auto.conf" <<EOF',
    "restore_command = 'cp /var/lib/kortix-recovery-wal/%f %p'",
    "recovery_target_time = '$target_time'",
    "recovery_target_timeline = 'latest'",
    "recovery_target_action = 'promote'",
    'EOF',
    'touch "$work/data/recovery.signal"',
    '',
    'compose=(docker compose --project-name "kortix-$KORTIX_INSTANCE" --env-file "$root/.env" -f "$root/docker-compose.yml" -f "$root/docker-compose.logs.yml" -f "$root/docker-compose.enterprise.yml")',
    'mapfile -t configured_images < <("${compose[@]}" config --images | sort -u)',
    'db_image=$(printf "%s\\n" "${configured_images[@]}" | grep -E "^supabase/postgres:.*@sha256:[a-f0-9]{64}$")',
    '[ -n "$db_image" ] || { echo "digest-pinned PostgreSQL image is missing" >&2; exit 1; }',
    'previous="${data_dir}.pre-pitr-$stamp"',
    'failed="${data_dir}.failed-pitr-$stamp"',
    'previous_recovery="${recovery_dir}.pre-pitr-$stamp"',
    '[ ! -e "$previous" ] && [ ! -e "$failed" ] && [ ! -e "$previous_recovery" ] || { echo "PITR quarantine path already exists" >&2; exit 1; }',
    'swapped=false',
    'recovery_flag=false',
    'started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'started_values=$(jq -cn --arg started_at "$started_at" \"{\\\":true\\\":{BOOL:true},\\\":false\\\":{BOOL:false},\\\":started_at\\\":{S:\\$started_at},\\\":now\\\":{N:\\\"$(date -u +%s)\\\"}}\")',
    'aws dynamodb update-item --table-name "$KORTIX_STATE_TABLE" --key "{\\"instance\\":{\\"S\\":\\"$KORTIX_INSTANCE\\"}}" --condition-expression "(attribute_not_exists(recovery_in_progress) OR recovery_in_progress = :false) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at < :now)" --update-expression "SET recovery_in_progress = :true, recovery_started_at = :started_at" --expression-attribute-values "$started_values" --region "$AWS_REGION" --output json >/dev/null',
    'recovery_flag=true',
    'clear_recovery_flag() {',
    '  clear_values=$(jq -cn \"{\\\":true\\\":{BOOL:true}}\")',
    '  aws dynamodb update-item --table-name "$KORTIX_STATE_TABLE" --key "{\\"instance\\":{\\"S\\":\\"$KORTIX_INSTANCE\\"}}" --condition-expression "recovery_in_progress = :true" --update-expression "REMOVE recovery_in_progress, recovery_started_at" --expression-attribute-values "$clear_values" --region "$AWS_REGION" --output json >/dev/null',
    '  recovery_flag=false',
    '}',
    'rollback_restore() {',
    '  code=$?',
    '  trap - EXIT INT TERM',
    '  restart_ok=true',
    '  if [ "$swapped" = true ]; then',
    '    "${compose[@]}" down --timeout 120 >/dev/null 2>&1 || true',
    '    [ ! -e "$data_dir" ] || mv "$data_dir" "$failed"',
    '    [ ! -e "$previous" ] || mv "$previous" "$data_dir"',
    '    [ ! -e "$recovery_dir" ] || mv "$recovery_dir" "${recovery_dir}.failed-pitr-$stamp"',
    '    [ ! -e "$previous_recovery" ] || mv "$previous_recovery" "$recovery_dir"',
    '    "$root/bin/supabase-start" >/dev/null 2>&1 || restart_ok=false',
    '  fi',
    '  if [ "$recovery_flag" = true ] && { [ "$swapped" = false ] || [ "$restart_ok" = true ]; }; then clear_recovery_flag || true; fi',
    '  exit "$code"',
    '}',
    'trap rollback_restore EXIT INT TERM',
    '"$root/bin/supabase-stop"',
    'mv "$data_dir" "$previous"',
    'swapped=true',
    'if [ -e "$recovery_dir" ]; then mv "$recovery_dir" "$previous_recovery"; fi',
    'mv "$work/data" "$data_dir"',
    'mv "$work/recovery-wal" "$recovery_dir"',
    'docker run --rm --user 0:0 --entrypoint sh -v "$data_dir:/data:Z" -v "$recovery_dir:/recovery:Z" "$db_image" -c \"chown -R \\\"\\$(id -u postgres):\\$(id -g postgres)\\\" /data /recovery && chmod 0700 /data /recovery\"',
    '"${compose[@]}" up --detach db',
    'attempts=${KORTIX_RESTORE_MAX_ATTEMPTS:-360}',
    'recovered=false',
    'for ((attempt=1; attempt<=attempts; attempt++)); do',
    '  if docker exec supabase-db pg_isready --username postgres --dbname postgres >/dev/null 2>&1 && [ "$(docker exec supabase-db psql --username postgres --dbname postgres --tuples-only --no-align --command "select not pg_is_in_recovery()")" = t ]; then',
    '    recovered=true',
    '    break',
    '  fi',
    '  sleep 5',
    'done',
    '[ "$recovered" = true ] || { echo "PostgreSQL did not reach and promote the requested recovery target" >&2; exit 1; }',
    '"$root/bin/supabase-start"',
    'restored_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'record=$(jq -cn --arg restored_at "$restored_at" --arg target_time "$target_time" --arg manifest_key "$manifest_key" --arg previous_data "$previous" \"{schema_version:1,restored_at:\\$restored_at,target_time:\\$target_time,manifest_key:\\$manifest_key,previous_data:\\$previous_data}\")',
    'printf "%s\\n" "$record" >"$work/restore.json"',
    'values=$(jq -cn --arg restored_at "$restored_at" --arg target_time "$target_time" --arg manifest_key "$manifest_key" \"{\\\":true\\\":{BOOL:true},\\\":restored_at\\\":{S:\\$restored_at},\\\":target_time\\\":{S:\\$target_time},\\\":manifest_key\\\":{S:\\$manifest_key}}\")',
    'aws dynamodb update-item --table-name "$KORTIX_STATE_TABLE" --key "{\\"instance\\":{\\"S\\":\\"$KORTIX_INSTANCE\\"}}" --condition-expression "recovery_in_progress = :true" --update-expression "SET last_restore_at = :restored_at, last_restore_target_time = :target_time, last_restore_manifest_key = :manifest_key REMOVE recovery_in_progress, recovery_started_at" --expression-attribute-values "$values" --region "$AWS_REGION" --output json >/dev/null',
    'recovery_flag=false',
    'trap - EXIT INT TERM',
    'printf "%s\\n" "$record"',
    '',
  ].join('\n');
}

function walArchiveService(): string {
  return `[Unit]
Description=Upload PostgreSQL WAL segments to customer S3
After=network-online.target kortix-supabase.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/kortix/current/bin/wal-archive
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
`;
}

function walArchiveTimer(): string {
  return `[Unit]
Description=Upload PostgreSQL WAL segments every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function baseBackupService(): string {
  return `[Unit]
Description=Create encrypted Kortix PostgreSQL physical base backup
After=network-online.target kortix-supabase.service
Requires=kortix-supabase.service

[Service]
Type=oneshot
ExecStart=/opt/kortix/current/bin/base-backup
TimeoutStartSec=7200
Nice=15
IOSchedulingClass=best-effort
IOSchedulingPriority=7
`;
}

function baseBackupTimer(): string {
  return `[Unit]
Description=Create daily Kortix PostgreSQL physical base backup

[Timer]
OnBootSec=30min
OnCalendar=*-*-* 03:30:00 UTC
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
`;
}
