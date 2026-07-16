#!/usr/bin/env bash
# Plan-guard for finding #1 of the 2026-07 production-readiness audit:
# Terraform destroying the data volume (aws_ebs_volume.data) on an instance
# replacement. The bug was the volume's availability_zone depending on
# aws_instance.this.availability_zone (ForceNew + a replaceable instance
# upstream == the volume becomes "known after apply" and gets replaced too).
# That's now fixed (storage.tf pins the AZ from the subnet, independent of
# the instance, plus lifecycle.prevent_destroy on the volume), but this
# script is a cheap, permanent tripwire against it — or anything else —
# regressing: point it at a saved plan (from any root module using this
# module) and it fails loudly if the plan would touch the data volume.
#
# Usage:
#   terraform plan -out=tf.plan
#   ./check-data-volume-safe.sh tf.plan
#
# Exit 0: no aws_ebs_volume.data resource instance in the plan is being
#         replaced or deleted (or none exists yet — nothing to check).
# Exit 1: at least one is — prints which, and refuses.
set -euo pipefail

PLAN_FILE="${1:?usage: $0 <saved-plan-file>}"

if ! command -v terraform >/dev/null 2>&1; then
  echo "FATAL: terraform CLI not found on PATH" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq not found on PATH (required to inspect the plan JSON)" >&2
  exit 2
fi

PLAN_JSON="$(terraform show -json "$PLAN_FILE")"

# resource_changes[].address for anything whose type is aws_ebs_volume and
# whose name is "data" (this module always names it aws_ebs_volume.data,
# possibly module-prefixed, e.g. module.selfhost.aws_ebs_volume.data), where
# the planned actions include delete and/or create (i.e. any replace, or a
# bare destroy).
UNSAFE="$(echo "$PLAN_JSON" | jq -r '
  [.resource_changes[]?
    | select(.type == "aws_ebs_volume" and .name == "data")
    | select((.change.actions | index("delete")) or (.change.actions | index("create") and (.change.actions | length) > 1))
  ] | .[] | .address
')"

if [ -n "$UNSAFE" ]; then
  echo "REFUSING: the plan in '$PLAN_FILE' would destroy/replace the self-host data volume:" >&2
  echo "$UNSAFE" >&2
  echo "" >&2
  echo "This is almost certainly the AZ-ForceNew class of bug (see storage.tf's" >&2
  echo "comment on aws_ebs_volume.data and the README's 'Replacing the instance" >&2
  echo "without losing data' section) unless you are deliberately retiring this" >&2
  echo "box's data on purpose — in which case remove lifecycle.prevent_destroy" >&2
  echo "first, in its own reviewed apply, and re-run this check to confirm it's" >&2
  echo "now the ONLY thing flagged." >&2
  exit 1
fi

echo "OK: no aws_ebs_volume.data replacement/destroy in '$PLAN_FILE'."
