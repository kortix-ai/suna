#!/usr/bin/env bash
# One-time: adopt the already-running dev Lightsail box into Terraform state.
# Safe to re-run — `terraform import` is a no-op for already-imported resources.
set -euo pipefail
cd "$(dirname "$0")"

terraform init -input=false

imp() {  # imp <address> <id>
  if terraform state list 2>/dev/null | grep -qx "$1"; then
    echo "  already imported: $1"
  else
    echo "  importing: $1  ($2)"
    terraform import "$1" "$2"
  fi
}

# Lightsail resource IDs are just their names. Static-IP resources are
# count-indexed (manage_static_ip=true → [0]).
imp 'module.api_host.aws_lightsail_instance.this'                'kortix-dev'
imp 'module.api_host.aws_lightsail_static_ip.this[0]'            'kortix-dev-ip'
imp 'module.api_host.aws_lightsail_static_ip_attachment.this[0]' 'kortix-dev-ip'
imp 'module.api_host.aws_lightsail_instance_public_ports.this'   'kortix-dev'

# Cloudflare DNS (dev-api.kortix.com). Requires TF_VAR_cloudflare_api_token +
# TF_VAR_cloudflare_zone_id in the environment.
if [ -n "${TF_VAR_cloudflare_api_token:-}" ] && [ -n "${TF_VAR_cloudflare_zone_id:-}" ]; then
  rec_id=$(curl -s -H "Authorization: Bearer ${TF_VAR_cloudflare_api_token}" \
    "https://api.cloudflare.com/client/v4/zones/${TF_VAR_cloudflare_zone_id}/dns_records?type=A&name=dev-api.kortix.com" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
  if [ -n "$rec_id" ]; then
    imp 'module.dns.cloudflare_record.this["dev-api"]' "${TF_VAR_cloudflare_zone_id}/${rec_id}"
  else
    echo "  ⚠ dev-api A record not found; 'terraform apply' will create it"
  fi
else
  echo "  ⚠ TF_VAR_cloudflare_api_token / TF_VAR_cloudflare_zone_id not set — skipping DNS import"
fi

echo
echo "Done. Now run:  terraform plan   (expect a near-empty diff)"
