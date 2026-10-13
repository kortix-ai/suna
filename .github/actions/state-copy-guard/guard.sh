#!/usr/bin/env bash
# See action.yml. Inputs: ROOT (Terraform root), MODE (fail | warn).
set -euo pipefail

OLD_BUCKET=kortix-terraform-state
backend="${ROOT}/backend.tf"
field() { sed -n "s/^ *$1 *= *\"\\(.*\\)\"\$/\\1/p" "$backend" | head -n 1; }
bucket="$(field bucket)"
key="$(field key)"

# Not moved yet (an older branch checkout), or no S3 backend: nothing to compare.
if [ -z "$bucket" ] || [ "$bucket" = "$OLD_BUCKET" ]; then
  exit 0
fi

case "$key" in
  dev-us-east-2/*) group=dev ;;
  security/*) group=global ;;
  staging-eu-west-2/*) group=staging ;;
  prod/*) group=prod ;;
  *) group="<group of ${key}>" ;;
esac

if out="$(aws s3api get-object-tagging --region us-west-2 --bucket "$OLD_BUCKET" --key "$key" \
  --query "TagSet[?Key=='statemove'].Value | [0]" --output text 2>&1)"; then
  [ "$out" = copied ] && exit 0
  msg="${ROOT}: the current version of s3://${OLD_BUCKET}/${key} was written after the last copy to s3://${bucket}, so that state may be stale."
else
  case "$out" in
    # The old key is gone (cleanup done) or only a delete marker is left.
    *NoSuchKey*|*"Not Found"*|*MethodNotAllowed*) exit 0 ;;
  esac
  msg="${ROOT}: cannot read the tags of s3://${OLD_BUCKET}/${key}: ${out}"
fi
msg="${msg} Run infra/terraform/scripts/statemove/copy-states.mjs ${group}, then deny-old-keys.mjs ${group} (same folder), and re-run."

if [ "$MODE" = warn ]; then
  echo "::warning title=Terraform state copy::${msg}"
  exit 0
fi
echo "::error title=Terraform state copy::${msg}"
exit 1
