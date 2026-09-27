#!/usr/bin/env bash
# Print the HTTPS origin of a pull request's preview environment.
#
#   preview-origin.sh <pr-number> [--wait]
#
# Reads the GitHub deployments that deploy-preview.yml publishes for
# environment `preview/pr-<N>`. The origin is stable for the life of the
# branch, so a redeploy keeps the same URL.
#
# Without --wait: prints the origin of the newest successful deployment. If it
# serves an older commit than the PR head, it still prints it and warns on
# stderr.
# With --wait: blocks (30 s polls, 45 min cap) until a deployment of the PR
# head commit succeeds, then prints its origin.
#
# Exit codes: 0 origin printed, 1 usage, 2 PR has no `preview` label,
# 3 not ready, 4 the deployment of the head commit failed.
set -euo pipefail

pr="${1:-}"
wait=0
[ "${2:-}" = "--wait" ] && wait=1
if ! [[ "$pr" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <pr-number> [--wait]" >&2
  exit 1
fi

repo="${PREVIEW_REPO:-kortix-ai/suna}"
deadline=$(( $(date +%s) + 45 * 60 ))

# One line per deployment, newest first: "<sha> <state> <environment_url>".
deployments() {
  local list sha url status
  list="$(gh api "repos/${repo}/deployments?environment=preview/pr-${pr}&per_page=10" \
    --jq '.[] | "\(.sha) \(.statuses_url)"')" || return 1
  while read -r sha url; do
    [ -n "$sha" ] || continue
    status="$(gh api "$url" \
      --jq '(.[0] // {}) | "\(.state // "pending") \(.environment_url // "" | if . == "" then "-" else . end)"')" || return 1
    echo "$sha $status"
  done <<<"$list"
}

# Reads the PR head, its label state, and its deployments into globals.
# Returns non-zero when a GitHub API call fails.
snapshot() {
  local pr_state
  pr_state="$(gh pr view "$pr" --repo "$repo" --json headRefOid,labels \
    --jq '"\(.headRefOid) \([.labels[].name] | index("preview") != null)"')" || return 1
  read -r head labelled <<<"$pr_state"
  rows="$(deployments)" || return 1
}

while :; do
  if ! snapshot; then
    # A transient API failure must not end a 45-minute wait.
    if [ "$wait" = 0 ]; then
      echo "GitHub API call failed; retry" >&2
      exit 3
    fi
    echo "GitHub API call failed; retrying in 30 s" >&2
    sleep 30
    continue
  fi
  if [ -z "$rows" ]; then
    if [ "$labelled" != true ]; then
      echo "PR #${pr} has no preview; add the label: gh pr edit ${pr} --add-label preview" >&2
      exit 2
    fi
    # The workflow creates the deployment only after the images build (~5 min).
    if [ "$wait" = 0 ]; then
      echo "preview for PR #${pr} is building; re-run with --wait" >&2
      exit 3
    fi
  fi
  head_row="$(awk -v h="$head" '$1 == h { print; exit }' <<<"$rows")"
  live_row="$(awk '$2 == "success" && $3 != "-" { print; exit }' <<<"$rows")"

  if [ -n "$head_row" ]; then
    read -r _ state origin <<<"$head_row"
    case "$state" in
      success)
        echo "$origin"
        exit 0
        ;;
      failure | error)
        echo "preview deployment of ${head:0:10} is '${state}'; read the deploy-preview.yml run log" >&2
        exit 4
        ;;
    esac
  fi

  if [ "$wait" = 0 ]; then
    if [ -n "$live_row" ]; then
      read -r live_sha _ origin <<<"$live_row"
      echo "warning: preview serves ${live_sha:0:10}, PR head is ${head:0:10}; use --wait for the head commit" >&2
      echo "$origin"
      exit 0
    fi
    echo "preview for PR #${pr} is not live yet; re-run with --wait" >&2
    exit 3
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "no successful preview deployment of ${head:0:10} after 45 min" >&2
    exit 3
  fi
  sleep 30
done
