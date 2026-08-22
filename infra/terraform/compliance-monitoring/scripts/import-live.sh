#!/usr/bin/env bash
set -euo pipefail

import_if_missing() {
  local address="$1"
  local id="$2"
  terraform state show "$address" >/dev/null 2>&1 || terraform import "$address" "$id"
}

import_region() {
  local region="$1"
  local prefix="$2"
  local web_acl="$3"

  while IFS=$'\t' read -r arn name; do
    local quoted_arn
    quoted_arn=$(printf '%s' "$arn" | sed 's/"/\\"/g')
    import_if_missing "aws_wafv2_web_acl_association.${prefix}[\"${quoted_arn}\"]" "$web_acl,$arn"
  done < <(aws elbv2 describe-load-balancers --region "$region" --output json |
    jq -r '.LoadBalancers[] | select(.Type == "application") | [.LoadBalancerArn, .LoadBalancerName] | @tsv')
}

account_id=$(aws sts get-caller-identity --query Account --output text)
import_region "us-west-2" "usw2" "arn:aws:wafv2:us-west-2:${account_id}:regional/webacl/kortix-alb-waf/4a81aadc-31ad-470a-a10c-3606de61cf65"
import_region "eu-west-2" "euw2" "arn:aws:wafv2:eu-west-2:${account_id}:regional/webacl/kortix-alb-waf/8ac41166-f4f0-4a53-9d23-f4aae0963a22"
