#!/usr/bin/env bash
# One-time: adopt the already-running prod Lightsail box into Terraform state.
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

# prod has no managed static IP (manage_static_ip = false) — only 2 resources.
imp 'module.api_host.aws_lightsail_instance.this'              'kortix-prod-xlarge-20260401'
imp 'module.api_host.aws_lightsail_instance_public_ports.this' 'kortix-prod-xlarge-20260401'

echo
echo "Done. Now run:  terraform plan   (expect a near-empty diff)"
