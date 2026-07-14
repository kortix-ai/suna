#!/usr/bin/env bash
#
# Kortix appliance bootstrap for a bare VPS (no Terraform, no AWS).
#
# A VPS is "the appliance minus Terraform": the SAME signed app + Supabase bundles
# and the SAME on-box updater run here as on AWS EC2. The only differences are how
# the box is provisioned (this script instead of Terraform user-data) and where the
# runtime keys live (a local 0600 JSON file instead of AWS Secrets Manager). TLS is
# ACME HTTP-01 (Route53 DNS-01 is AWS-only). After bootstrap, the systemd updater
# timer keeps the box converged to the signed `stable` channel — identically to AWS.
#
# Run as root on a fresh Ubuntu 22.04/24.04 host with a public IP and the two app
# DNS records (api + frontend) already pointing at it (Caddy needs them for HTTP-01).
#
# Required environment:
#   KORTIX_INSTANCE                  lowercase slug (4-32 chars, no kortix- prefix)
#   KORTIX_API_DOMAIN                e.g. api.acme.example.com
#   KORTIX_FRONTEND_DOMAIN           e.g. acme.example.com
#   KORTIX_RELEASE_REPOSITORY        https URL of the enterprise TUF repository
#   KORTIX_TUF_ROOT_SHA256           offline-reviewed trusted TUF root digest
#   KORTIX_UPDATER_BOOTSTRAP_URL     https URL of the initial updater binary
#   KORTIX_UPDATER_BOOTSTRAP_SHA256  sha256 of that binary (the box then self-updates
#                                    to the signed channel binary via TUF on first run)
#   DAYTONA_API_KEY                  agent sandbox provider key
#   SMTP_ADMIN_EMAIL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_SENDER_NAME
# Exactly one LLM upstream:
#   AWS_BEDROCK_API_KEY (+ AWS_BEDROCK_REGION, default us-west-2)   managed Claude→Bedrock
#   or OPENROUTER_API_KEY
# Optional:
#   KORTIX_ACME_EMAIL                ACME contact (recommended)
#
set -euo pipefail
umask 077

log() { printf '\033[1mkortix-bootstrap:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mkortix-bootstrap: %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"

req() { local v="${!1:-}"; [ -n "$v" ] || die "missing required env $1"; printf '%s' "$v"; }

INSTANCE=$(req KORTIX_INSTANCE)
API_DOMAIN=$(req KORTIX_API_DOMAIN)
FRONTEND_DOMAIN=$(req KORTIX_FRONTEND_DOMAIN)
RELEASE_REPOSITORY=$(req KORTIX_RELEASE_REPOSITORY)
TUF_ROOT_SHA256=$(req KORTIX_TUF_ROOT_SHA256)
UPDATER_URL=$(req KORTIX_UPDATER_BOOTSTRAP_URL)
UPDATER_SHA256=$(req KORTIX_UPDATER_BOOTSTRAP_SHA256)
ACME_EMAIL="${KORTIX_ACME_EMAIL:-}"

echo "$INSTANCE" | grep -Eq '^[a-z][a-z0-9-]{2,30}[a-z0-9]$' || die "KORTIX_INSTANCE is not a valid slug"
case "$INSTANCE" in kortix-*) die "KORTIX_INSTANCE must not start with kortix-";; esac
echo "$RELEASE_REPOSITORY" | grep -Eq '^https://' || die "KORTIX_RELEASE_REPOSITORY must be https"
echo "$TUF_ROOT_SHA256" | grep -Eq '^[a-f0-9]{64}$' || die "KORTIX_TUF_ROOT_SHA256 must be 64 hex"
echo "$UPDATER_SHA256" | grep -Eq '^[a-f0-9]{64}$' || die "KORTIX_UPDATER_BOOTSTRAP_SHA256 must be 64 hex"
for d in "$API_DOMAIN" "$FRONTEND_DOMAIN"; do
  echo "$d" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' \
    || die "unsafe domain: $d"
done

# ── Packages ─────────────────────────────────────────────────────────────────
log "installing docker, compose, jq, openssl"
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  curl --fail --silent --show-error --location https://get.docker.com | sh
fi
apt-get update -y
apt-get install -y jq openssl ca-certificates docker-compose-plugin >/dev/null 2>&1 || \
  apt-get install -y jq openssl ca-certificates
docker compose version >/dev/null 2>&1 || die "docker compose plugin is not available"
systemctl enable --now docker

install -d -m 0755 /etc/kortix /opt/kortix/releases /opt/kortix/bin
install -d -m 0700 /var/lib/kortix

# ── Runtime keys (the VPS analogue of the CLI's Secrets Manager bootstrap) ────
# Generated once and never rotated here; keep /etc/kortix/runtime.json 0600.
RUNTIME_JSON=/etc/kortix/runtime.json
# Host address the in-box Kong + Postgres are reachable at from the app containers
# (server-side only; never the public URL). The Supabase stack publishes Kong on
# host :8000 and Supavisor on :5432; app containers reach them at the host IP.
HOST_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
[ -n "$HOST_IP" ] || HOST_IP=$(hostname -I | awk '{print $1}')
[ -n "$HOST_IP" ] || die "could not determine host IP for the in-box Supabase origin"

if [ ! -f "$RUNTIME_JSON" ]; then
  log "generating runtime keys → $RUNTIME_JSON"
  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  hex() { openssl rand -hex "$1"; }
  # Supabase HS256 JWT for a fixed long-lived role (matches the CLI's issuer).
  jwt() { # $1=role $2=secret
    local h p s
    h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
    p=$(printf '{"role":"%s","iss":"supabase","iat":1641024000,"exp":2114380800}' "$1" | b64url)
    s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$2" -binary | b64url)
    printf '%s.%s.%s' "$h" "$p" "$s"
  }
  JWT_SECRET=$(hex 32)
  POSTGRES_PASSWORD=$(hex 32)
  ANON_KEY=$(jwt anon "$JWT_SECRET")
  SERVICE_ROLE_KEY=$(jwt service_role "$JWT_SECRET")

  bedrock_region="${AWS_BEDROCK_REGION:-us-west-2}"
  # LLM upstream: exactly one of Bedrock (bearer key) or OpenRouter.
  llm_json='{}'
  if [ -n "${AWS_BEDROCK_API_KEY:-}" ]; then
    llm_json=$(jq -n --arg k "$AWS_BEDROCK_API_KEY" --arg r "$bedrock_region" '{AWS_BEDROCK_API_KEY:$k, AWS_BEDROCK_REGION:$r}')
  elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
    llm_json=$(jq -n --arg k "$OPENROUTER_API_KEY" '{OPENROUTER_API_KEY:$k}')
  else
    die "set AWS_BEDROCK_API_KEY (managed Claude→Bedrock) or OPENROUTER_API_KEY"
  fi

  jq -n \
    --arg jwt "$JWT_SECRET" --arg pg "$POSTGRES_PASSWORD" \
    --arg anon "$ANON_KEY" --arg svc "$SERVICE_ROLE_KEY" \
    --arg pub "sb_publishable_$(hex 24)" --arg sec "sb_secret_$(hex 32)" \
    --arg dashpw "$(hex 24)" --arg skb "$(hex 48)" \
    --arg realtime "$(hex 8)" --arg vault "$(hex 16)" --arg pgmeta "$(hex 24)" \
    --arg lfpub "$(hex 24)" --arg lfpriv "$(hex 24)" \
    --arg s3id "$(hex 16)" --arg s3sec "$(hex 32)" \
    --arg gw "$(hex 32)" --arg isk "$(hex 32)" --arg aks "$(hex 32)" --arg tss "$(hex 32)" \
    --arg instance "$INSTANCE" --arg hostip "$HOST_IP" \
    --arg api "https://$API_DOMAIN" --arg fe "https://$FRONTEND_DOMAIN" \
    --arg smtp_email "$(req SMTP_ADMIN_EMAIL)" --arg smtp_host "$(req SMTP_HOST)" \
    --arg smtp_port "$(req SMTP_PORT)" --arg smtp_user "$(req SMTP_USER)" \
    --arg smtp_pass "$(req SMTP_PASS)" --arg smtp_from "$(req SMTP_SENDER_NAME)" \
    --arg daytona "$(req DAYTONA_API_KEY)" \
    --argjson llm "$llm_json" \
    '{
      POSTGRES_PASSWORD:$pg, JWT_SECRET:$jwt, SUPABASE_JWT_SECRET:$jwt,
      ANON_KEY:$anon, SUPABASE_ANON_KEY:$anon,
      SERVICE_ROLE_KEY:$svc, SUPABASE_SERVICE_ROLE_KEY:$svc,
      SUPABASE_PUBLISHABLE_KEY:$pub, SUPABASE_SECRET_KEY:$sec,
      DASHBOARD_USERNAME:"kortix", DASHBOARD_PASSWORD:$dashpw,
      SECRET_KEY_BASE:$skb, REALTIME_DB_ENC_KEY:$realtime, VAULT_ENC_KEY:$vault,
      PG_META_CRYPTO_KEY:$pgmeta,
      LOGFLARE_PUBLIC_ACCESS_TOKEN:$lfpub, LOGFLARE_PRIVATE_ACCESS_TOKEN:$lfpriv,
      S3_PROTOCOL_ACCESS_KEY_ID:$s3id, S3_PROTOCOL_ACCESS_KEY_SECRET:$s3sec,
      POOLER_TENANT_ID:$instance,
      GATEWAY_INTERNAL_TOKEN:$gw, INTERNAL_SERVICE_KEY:$isk, API_KEY_SECRET:$aks,
      TUNNEL_SIGNING_SECRET:$tss,
      SUPABASE_URL:("http://" + $hostip + ":8000"),
      DATABASE_URL:("postgresql://postgres." + $instance + ":" + $pg + "@" + $hostip + ":5432/postgres"),
      SUPABASE_PUBLIC_URL:$fe, PUBLIC_URL:$fe,
      API_PUBLIC_URL:$api, KORTIX_URL:$api,
      KORTIX_PUBLIC_URL:$fe, KORTIX_PUBLIC_BACKEND_URL:($api + "/v1"),
      KORTIX_PUBLIC_SUPABASE_URL:$fe, KORTIX_PUBLIC_SUPABASE_ANON_KEY:$anon,
      INTERNAL_KORTIX_ENV:"prod", KORTIX_BILLING_INTERNAL_ENABLED:"false",
      SMTP_ADMIN_EMAIL:$smtp_email, SMTP_HOST:$smtp_host, SMTP_PORT:$smtp_port,
      SMTP_USER:$smtp_user, SMTP_PASS:$smtp_pass, SMTP_SENDER_NAME:$smtp_from,
      ALLOWED_SANDBOX_PROVIDERS:"daytona", DAYTONA_API_KEY:$daytona,
      DAYTONA_SERVER_URL:"https://app.daytona.io/api", DAYTONA_TARGET:"us",
      ENABLE_EMAIL_SIGNUP:"true", ENABLE_EMAIL_AUTOCONFIRM:"false",
      ENABLE_ANONYMOUS_USERS:"false", ENABLE_PHONE_SIGNUP:"false",
      ENABLE_PHONE_AUTOCONFIRM:"false", DISABLE_SIGNUP:"false"
    } + $llm' > "$RUNTIME_JSON"
  chmod 0600 "$RUNTIME_JSON"
else
  log "reusing existing $RUNTIME_JSON"
fi

# ── instance.env (VPS variant: local env file, HTTP-01, no AWS) ───────────────
log "writing /etc/kortix/instance.env"
cat >/etc/kortix/instance.env <<ENV
KORTIX_INSTANCE=$INSTANCE
KORTIX_CHANNEL=stable
KORTIX_RELEASE_REPOSITORY=$RELEASE_REPOSITORY
KORTIX_TUF_ROOT_SHA256=$TUF_ROOT_SHA256
KORTIX_API_DOMAIN=$API_DOMAIN
KORTIX_FRONTEND_DOMAIN=$FRONTEND_DOMAIN
KORTIX_ACME_EMAIL=$ACME_EMAIL
KORTIX_ACME_PROVIDER=http
KORTIX_RUNTIME_ENV_FILE=$RUNTIME_JSON
ENV
chmod 0600 /etc/kortix/instance.env

# ── Initial updater binary (self-updates to the signed channel binary on run) ─
log "installing the bootstrap updater binary"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "$UPDATER_URL" -o /opt/kortix/bin/kortix-updater
echo "$UPDATER_SHA256  /opt/kortix/bin/kortix-updater" | sha256sum --check --strict
chmod 0755 /opt/kortix/bin/kortix-updater

# ── kortix-supabase.service (identical to the AWS user-data seed) ─────────────
# The app bundle installs its own kortix-app/updater/watchdog/prune units; this
# one is the only unit the platform provisions, exactly as on EC2.
cat >/etc/systemd/system/kortix-supabase.service <<'UNIT'
[Unit]
Description=Kortix private Supabase runtime
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/kortix/instance.env
ExecStart=/bin/bash -c 'if [ -x /opt/kortix/current/bin/supabase-start ]; then exec /opt/kortix/current/bin/supabase-start; else echo "awaiting signed release reconciliation"; fi'
ExecStop=/bin/bash -c 'if [ -x /opt/kortix/current/bin/supabase-stop ]; then exec /opt/kortix/current/bin/supabase-stop; fi'
TimeoutStartSec=1800
TimeoutStopSec=300

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable kortix-supabase.service

# ── First reconcile (TUF verify → pull → migrate → roll → health → breadcrumb) ─
log "running the on-box updater (first reconcile)"
set -a
# shellcheck disable=SC1091
. /etc/kortix/instance.env
set +a
/opt/kortix/bin/kortix-updater run

log "done. The kortix-updater.timer (installed by the app bundle) now keeps this"
log "box converged to the signed stable channel. Check: systemctl list-timers | grep kortix"
