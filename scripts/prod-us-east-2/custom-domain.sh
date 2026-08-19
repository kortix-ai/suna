#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_PROJECT_REF="${SOURCE_PROJECT_REF:-jbriwassebxdwoieikga}"
TARGET_PROJECT_REF="${TARGET_PROJECT_REF:-uhrwvisbqjfxhxjvoofd}"
CUSTOM_HOSTNAME="${CUSTOM_HOSTNAME:-supa.kortix.com}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

for command_name in dig supabase; do
  require_command "$command_name"
done

domain_exists() {
  local project_ref="$1"
  supabase domains get \
    --project-ref "$project_ref" \
    --output json >/dev/null 2>&1
}

status() {
  for project_ref in "$SOURCE_PROJECT_REF" "$TARGET_PROJECT_REF"; do
    if domain_exists "$project_ref"; then
      echo "$project_ref: custom domain configured"
      supabase domains get --project-ref "$project_ref" --output json
    else
      echo "$project_ref: no custom domain configured"
    fi
  done
  echo "$CUSTOM_HOSTNAME CNAME: $(dig +short CNAME "$CUSTOM_HOSTNAME" | tail -1)"
}

detach_domain() {
  local side="$1"
  local project_ref
  local confirmation
  if [[ "$side" == "source" ]]; then
    project_ref="$SOURCE_PROJECT_REF"
    confirmation="detach-source:${CUSTOM_HOSTNAME}"
  else
    project_ref="$TARGET_PROJECT_REF"
    confirmation="detach-target:${CUSTOM_HOSTNAME}"
  fi

  if [[ "${SUPABASE_DOMAIN_CONFIRM:-}" != "$confirmation" ]]; then
    echo "Set SUPABASE_DOMAIN_CONFIRM=$confirmation." >&2
    exit 64
  fi
  if ! domain_exists "$project_ref"; then
    echo "$project_ref has no custom domain configuration."
    return
  fi

  supabase domains delete --project-ref "$project_ref" --yes
  if domain_exists "$project_ref"; then
    echo "$project_ref still has a custom domain configuration." >&2
    exit 1
  fi
  echo "Detached $CUSTOM_HOSTNAME from $project_ref."
}

attach_domain() {
  local side="$1"
  local project_ref
  local expected_cname
  local confirmation
  local live_cname

  if [[ "$side" == "source" ]]; then
    project_ref="$SOURCE_PROJECT_REF"
    expected_cname="${SOURCE_PROJECT_REF}.supabase.co."
    confirmation="attach-source:${CUSTOM_HOSTNAME}"
  else
    project_ref="$TARGET_PROJECT_REF"
    expected_cname="${TARGET_PROJECT_REF}.supabase.co."
    confirmation="attach-target:${CUSTOM_HOSTNAME}"
  fi

  if [[ "${SUPABASE_DOMAIN_CONFIRM:-}" != "$confirmation" ]]; then
    echo "Set SUPABASE_DOMAIN_CONFIRM=$confirmation." >&2
    exit 64
  fi
  live_cname="$(dig +short CNAME "$CUSTOM_HOSTNAME" | tail -1)"
  if [[ "$live_cname" != "$expected_cname" ]]; then
    echo "$CUSTOM_HOSTNAME points to '${live_cname:-missing}', expected '$expected_cname'." >&2
    exit 1
  fi

  if ! domain_exists "$project_ref"; then
    supabase domains create \
      --project-ref "$project_ref" \
      --custom-hostname "$CUSTOM_HOSTNAME" \
      --yes
  fi

  for attempt in $(seq 1 60); do
    supabase domains reverify \
      --project-ref "$project_ref" \
      --yes >/dev/null 2>&1 || true
    if supabase domains activate \
      --project-ref "$project_ref" \
      --yes >/dev/null 2>&1; then
      supabase domains get --project-ref "$project_ref" --output json
      echo "Activated $CUSTOM_HOSTNAME on $project_ref."
      return
    fi
    echo "Custom-domain activation $attempt/60 is not ready."
    sleep 5
  done

  echo "$CUSTOM_HOSTNAME did not activate on $project_ref within five minutes." >&2
  exit 1
}

case "${1:-}" in
  status)
    status
    ;;
  detach-source)
    detach_domain source
    ;;
  attach-target)
    attach_domain target
    ;;
  detach-target)
    detach_domain target
    ;;
  attach-source)
    attach_domain source
    ;;
  *)
    echo "Usage: scripts/prod-us-east-2/custom-domain.sh {status|detach-source|attach-target|detach-target|attach-source}" >&2
    exit 64
    ;;
esac
