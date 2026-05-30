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

# Lightsail resource IDs are just their names.
imp 'module.api_host.aws_lightsail_instance.this'             'kortix-dev'
imp 'module.api_host.aws_lightsail_static_ip.this'            'kortix-dev-ip'
imp 'module.api_host.aws_lightsail_static_ip_attachment.this' 'kortix-dev-ip'
imp 'module.api_host.aws_lightsail_instance_public_ports.this' 'kortix-dev'

echo
echo "Done. Now run:  terraform plan   (expect a near-empty diff)"
