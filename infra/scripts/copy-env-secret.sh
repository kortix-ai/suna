#!/usr/bin/env bash
#
# copy-env-secret.sh — copy a Kortix env blob (a Secrets Manager JSON object)
# to another region, for the region-consolidation stacks
# (infra/terraform/environments/dev-us-east-2, staging-eu-west-2 and their
# -web roots). Values never reach stdout, stderr, or disk: the JSON travels
# through one pipe, and the output names keys only.
#
# Usage:
#   copy-env-secret.sh <name> <from-region> <to-region> [--to-name NAME]
#                      [--workers on|off] [--check]
#
#   --to-name   target secret name (default: <name>)
#   --workers   set KORTIX_WORKERS_ENABLED in the copy: off = "false" (the
#               stack serves requests but never takes the background-worker
#               lease, apps/api/src/shared/leader-election.ts), on = "true".
#               Omitted: copied unchanged.
#   --check     write nothing; list the keys whose values differ between
#               source and target (KORTIX_WORKERS_ENABLED excluded). Exit 1
#               when any differ, so a re-sync is due.
#
# Creates the target when it is missing, else writes a new version.
set -euo pipefail

usage() { sed -n '9,21p' "$0" >&2; exit 2; }
[ $# -ge 3 ] || usage
NAME="$1" FROM="$2" TO="$3"; shift 3
TO_NAME="$NAME" WORKERS="" CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to-name) TO_NAME="${2:?}"; shift 2 ;;
    --workers) WORKERS="${2:?}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    *) usage ;;
  esac
done
case "$WORKERS" in ""|on|off) ;; *) usage ;; esac
[ "$FROM:$NAME" != "$TO:$TO_NAME" ] || { echo "source and target are the same secret" >&2; exit 2; }

read_secret() {
  aws secretsmanager get-secret-value --region "$1" --secret-id "$2" \
    --query SecretString --output text
}

# jq program: the source object with the workers flag applied.
transform='if type != "object" or any(.[]; type != "string") then
    error("not a JSON object of strings")
  elif $workers == "on" then .KORTIX_WORKERS_ENABLED = "true"
  elif $workers == "off" then .KORTIX_WORKERS_ENABLED = "false"
  else . end'

if [ "$CHECK" = 1 ]; then
  # --slurpfile, not --argjson: a value on argv is visible in the process list.
  diff_keys="$(
    jq -rn --slurpfile a <(read_secret "$FROM" "$NAME") \
           --slurpfile b <(read_secret "$TO" "$TO_NAME") '
      $a[0] as $a | $b[0] as $b
      | ($a + $b | keys) - ["KORTIX_WORKERS_ENABLED"]
      | map(select($a[.] != $b[.])) | join(",")'
  )"
  if [ -n "$diff_keys" ]; then
    echo "differ: $diff_keys"
    exit 1
  fi
  echo "in sync: $FROM/$NAME = $TO/$TO_NAME (KORTIX_WORKERS_ENABLED excluded)"
  exit 0
fi

payload="$(read_secret "$FROM" "$NAME" | jq -c --arg workers "$WORKERS" "$transform")"
if aws secretsmanager describe-secret --region "$TO" --secret-id "$TO_NAME" >/dev/null 2>&1; then
  printf '%s' "$payload" | aws secretsmanager put-secret-value --region "$TO" \
    --secret-id "$TO_NAME" --secret-string file:///dev/stdin >/dev/null
  verb=updated
else
  printf '%s' "$payload" | aws secretsmanager create-secret --region "$TO" \
    --name "$TO_NAME" --secret-string file:///dev/stdin \
    --description "Copy of $FROM/$NAME (infra/scripts/copy-env-secret.sh)" >/dev/null
  verb=created
fi
echo "$verb $TO/$TO_NAME from $FROM/$NAME: $(jq 'length' <<<"$payload") keys," \
  "KORTIX_WORKERS_ENABLED=$(jq -r '.KORTIX_WORKERS_ENABLED // "unset"' <<<"$payload")"
