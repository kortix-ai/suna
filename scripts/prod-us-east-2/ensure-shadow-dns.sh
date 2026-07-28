#!/usr/bin/env bash
set -Eeuo pipefail

CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CLOUDFLARE_GLOBAL_API_KEY="${CLOUDFLARE_GLOBAL_API_KEY:-}"
CLOUDFLARE_EMAIL="${CLOUDFLARE_EMAIL:-}"
AWS_REGION="${AWS_REGION:-us-east-2}"
CLOUDFLARE_ZONE_NAME="${CLOUDFLARE_ZONE_NAME:-kortix.com}"

for command_name in aws curl jq; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

if [[ -n "$CLOUDFLARE_API_TOKEN" ]]; then
  cloudflare_auth_headers=(
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  )
elif [[ -n "$CLOUDFLARE_GLOBAL_API_KEY" && -n "$CLOUDFLARE_EMAIL" ]]; then
  cloudflare_auth_headers=(
    -H "X-Auth-Email: $CLOUDFLARE_EMAIL"
    -H "X-Auth-Key: $CLOUDFLARE_GLOBAL_API_KEY"
  )
else
  echo "Cloudflare API token or global API key credentials are required." >&2
  exit 1
fi

cloudflare_request() {
  curl -fsS \
    "${cloudflare_auth_headers[@]}" \
    -H "Content-Type: application/json" \
    "$@"
}

zone_response="$(
  cloudflare_request \
    "https://api.cloudflare.com/client/v4/zones?name=${CLOUDFLARE_ZONE_NAME}&status=active"
)"
zone_id="$(jq -er '.result | select(length == 1) | .[0].id' <<<"$zone_response")"

api_origin="$(
  aws elbv2 describe-load-balancers \
    --region "$AWS_REGION" \
    --names kortix-prod-use2-alb \
    --query 'LoadBalancers[0].DNSName' \
    --output text
)"
gateway_origin="$(
  aws elbv2 describe-load-balancers \
    --region "$AWS_REGION" \
    --names kortix-prod-use2-gateway-alb \
    --query 'LoadBalancers[0].DNSName' \
    --output text
)"

ensure_record() {
  local hostname="$1"
  local expected_origin="$2"
  local record_count
  local record_response
  local record_id
  local request_method
  local request_url
  local update_response

  record_response="$(
    cloudflare_request \
      "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?type=CNAME&name=${hostname}"
  )"
  record_count="$(jq -er '.result | length' <<<"$record_response")"
  case "$record_count" in
    0)
      request_method="POST"
      request_url="https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records"
      ;;
    1)
      record_id="$(jq -er '.result[0].id' <<<"$record_response")"
      request_method="PUT"
      request_url="https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records/${record_id}"
      ;;
    *)
      echo "Expected at most one CNAME for $hostname, found $record_count." >&2
      exit 1
      ;;
  esac

  update_response="$(
    cloudflare_request \
      --request "$request_method" \
      --data "$(
        jq -nc \
          --arg name "$hostname" \
          --arg content "$expected_origin" \
          '{
            type: "CNAME",
            name: $name,
            content: $content,
            ttl: 1,
            proxied: true
          }'
      )" \
      "$request_url"
  )"

  jq -e \
    --arg name "$hostname" \
    --arg content "$expected_origin" \
    '.success == true
      and .result.name == $name
      and .result.content == $content
      and .result.proxied == true' \
    <<<"$update_response" >/dev/null

  echo "$hostname: proxied CNAME to $expected_origin"
}

ensure_record api-use2-shadow.kortix.com "$api_origin"
ensure_record gateway-use2-shadow.kortix.com "$gateway_origin"
