#!/bin/bash
# Helper script to run terraform imports
# Usage: ./import-all.sh [dev|staging|prod]

set -e

ENV=${1:-prod}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_DIR="$SCRIPT_DIR/../environments/$ENV"

if [ ! -d "$ENV_DIR" ]; then
  echo "Error: Environment directory not found: $ENV_DIR"
  exit 1
fi

cd "$ENV_DIR"

echo "Initializing Terraform for $ENV environment..."
terraform init

echo "Planning imports for $ENV environment..."
terraform plan

echo ""
echo "To apply imports, run:"
echo "  cd $ENV_DIR"
echo "  terraform apply"
echo ""
echo "Note: Review the plan carefully before applying!"
