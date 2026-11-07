#!/usr/bin/env bash
#
# announce-dev-live.sh — tell every pull request a Deploy Dev run shipped that
# its commit is live on dev, or that it is not yet and why.
#
# One sticky comment per pull request (marker `<!-- dev-live -->`), edited in
# place, so a later deploy that fixes a failed one turns "Not live on dev yet"
# into "Live on dev" without a second notification thread. "Live" is proven by
# /health on each surface the run deployed, never inferred from job results.
#
# Environment (all set by the `announce-live` job in deploy-dev.yml):
#   GITHUB_REPOSITORY  owner/repo
#   SHA                commit this run deployed (github.sha)
#   BASE               commit dev ran before this run (detect-changes); empty
#                      when unknown, then only SHA's pull request is announced
#   RUN_URL            this workflow run
#   API_RESULT, GATEWAY_RESULT, WEB_RESULT
#                      success | failure | cancelled | skipped | unchanged
#   NOW_EPOCH          optional, for tests
#   STALE_SWEEP        1 (default) corrects stale "Not live on dev yet"
#                      comments of recent pull requests outside the range
#
# Never fails the deploy: a GitHub API error becomes a ::warning:: and exit 0.

set -euo pipefail

marker='<!-- dev-live -->'
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
sha="${SHA:?SHA required}"
base="${BASE:-}"
run_url="${RUN_URL:-}"
now="${NOW_EPOCH:-$(date +%s)}"
short="${sha:0:10}"
max_prs=50

warn() { echo "::warning::announce-dev-live: $*"; }

# shellcheck source=scripts/ci/lib/github-comment.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/github-comment.sh"

# label | /health URL | name of the variable holding the surface's deploy result
DEV_SURFACES=(
  'API · dev-api.kortix.com|https://dev-api.kortix.com/v1/health|API_RESULT'
  'Gateway · gateway-dev.kortix.com|https://gateway-dev.kortix.com/health/live|GATEWAY_RESULT'
  'Web · dev.kortix.com|https://dev.kortix.com/api/health|WEB_RESULT'
)

# ── per-surface verdict ──────────────────────────────────────────────────────
rows=()
live=true
probe() {
  local label="$1" result="$2" url="$3" commit
  [ "$result" = unchanged ] && return 0
  if [ "$result" != success ]; then
    rows+=("| ${label} | deploy ${result} |")
    live=false
    return 0
  fi
  commit="$(curl -fsS --max-time 10 "$url" 2>/dev/null | jq -r '.commit // empty' 2>/dev/null || true)"
  if [ "$commit" = "$sha" ]; then
    rows+=("| ${label} | serving \`${short}\` |")
  else
    rows+=("| ${label} | deployed; \`/health\` reports \`${commit:0:10}\` |")
    live=false
  fi
}
for surface in "${DEV_SURFACES[@]}"; do
  IFS='|' read -r label url result_var <<<"$surface"
  probe "$label" "${!result_var:-unchanged}" "$url"
done

if [ "${#rows[@]}" -eq 0 ]; then
  echo "announce-dev-live: no surface deployed in this run; nothing to announce"
  exit 0
fi

# ── pull requests this run shipped ───────────────────────────────────────────
commits=()
if [ -n "$base" ] && [ "$base" != "$sha" ]; then
  if listing="$(gh api "repos/${repo}/compare/${base}...${sha}" 2>/dev/null)"; then
    while IFS= read -r c; do [ -n "$c" ] && commits+=("$c"); done \
      < <(jq -r '.commits[]?.sha // empty' <<<"$listing")
  else
    warn "could not list ${base:0:10}...${short}; announcing ${short} only"
  fi
fi
[ "${#commits[@]}" -gt 0 ] || commits=("$sha")

prs=()
for c in "${commits[@]}"; do
  number="$(gh api "repos/${repo}/commits/${c}/pulls" 2>/dev/null \
    | jq -r '[.[] | select(.merged_at != null and .base.ref == "dev")][0].number // empty' 2>/dev/null || true)"
  [ -n "$number" ] || continue
  case " ${prs[*]:-} " in *" ${number} "*) continue ;; esac
  prs+=("$number")
done
if [ "${#prs[@]}" -eq 0 ]; then
  echo "announce-dev-live: no merged pull request in ${base:+${base:0:10}...}${short}; nothing to announce"
  exit 0
fi
if [ "${#prs[@]}" -gt "$max_prs" ]; then
  warn "${#prs[@]} pull requests in range; announcing the newest ${max_prs}"
  prs=("${prs[@]: -$max_prs}")
fi

lead_time() {
  local merged="$1" seconds
  seconds=$(( now - $(date -u -d "$merged" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$merged" +%s) ))
  [ "$seconds" -ge 0 ] || seconds=0
  if [ "$seconds" -ge 3600 ]; then
    printf '%dh %dm' $(( seconds / 3600 )) $(( seconds % 3600 / 60 ))
  else
    printf '%dm %ds' $(( seconds / 60 )) $(( seconds % 60 ))
  fi
}

# ── one sticky comment per pull request ──────────────────────────────────────
summary=("### Dev deploy announcement" "" "| Pull request | Status |" "|---|---|")
for number in "${prs[@]}"; do
  merged_at="$(gh api "repos/${repo}/pulls/${number}" 2>/dev/null | jq -r '.merged_at // empty' 2>/dev/null || true)"
  if [ "$live" = true ]; then
    title="### Live on dev${merged_at:+ — $(lead_time "$merged_at") after merge}"
    lead="\`${short}\` serves on every surface this deploy changed, checked on \`/health\`."
  else
    title='### Not live on dev yet'
    lead="\`${short}\` did not reach every surface this deploy changed. The next deploy from \`dev\` retries every surface that is still stale, and edits this comment."
  fi
  others=()
  for other in "${prs[@]}"; do [ "$other" = "$number" ] || others+=("#${other}"); done
  together=""
  [ "${#others[@]}" -eq 0 ] || together="Shipped together with $(printf '%s, ' "${others[@]}" | sed 's/, $//')."
  body="$(printf '%s\n' "$marker" "$title" '' "$lead" '' '| Surface | Result |' '|---|---|' "${rows[@]}" '' \
    "Deploy run: ${run_url}${together:+. ${together}}")"

  upsert_sticky_comment "$repo" "$number" "$marker" "$body" && rc=0 || rc=$?
  case "$rc" in
    3) warn "could not edit the comment on #${number}" ;;
    4) warn "could not comment on #${number}" ;;
  esac
  summary+=("| #${number} | $([ "$live" = true ] && echo live || echo 'not live') |")
done

# ── correct stale "Not live on dev yet" comments outside this range ───────────
# A pull request whose deploy failed stays "Not live" until a run's range
# contains it again. Deploy Dev diffs each surface against the commit it
# serves, so the next run that builds the failed surface covers it. A surface
# that failed its check but serves the commit anyway is not rebuilt, so check
# the recent ones here: when every surface (API, gateway, web) serves a commit
# that contains the pull request's merge commit, it is live.
corrected=()
if [ "$live" = true ] && [ "${STALE_SWEEP:-1}" = 1 ]; then
  served=()
  for surface in "${DEV_SURFACES[@]}"; do
    IFS='|' read -r _ url _ <<<"$surface"
    served+=("$(curl -fsS --max-time 10 "$url" 2>/dev/null | jq -r '.commit // empty' 2>/dev/null || true)")
  done
  candidates="$(gh api "repos/${repo}/pulls?state=closed&base=dev&sort=updated&direction=desc&per_page=30" 2>/dev/null \
    | jq -r '.[] | select(.merged_at != null) | "\(.number) \(.merge_commit_sha)"' 2>/dev/null || true)"
  while read -r number merge; do
    [ -n "$number" ] && [ -n "$merge" ] || continue
    case " ${prs[*]:-} " in *" ${number} "*) continue ;; esac
    comment="$(sticky_comment "$repo" "$number" "$marker")"
    [ -n "$comment" ] || continue
    jq -e '.body | contains("### Not live on dev yet")' <<<"$comment" >/dev/null 2>&1 || continue
    contained=true
    for commit in "${served[@]}"; do
      status=""
      [ -z "$commit" ] || status="$(gh api "repos/${repo}/compare/${merge}...${commit}" 2>/dev/null | jq -r '.status // empty' 2>/dev/null || true)"
      case "$status" in ahead|identical) ;; *) contained=false; break ;; esac
    done
    [ "$contained" = true ] || continue
    id="$(jq -r .id <<<"$comment")"
    body="$(printf '%s\n' "$marker" '### Live on dev' '' \
      "Every surface serves a commit that contains this pull request's merge \`${merge:0:10}\`, checked on \`/health\` (API \`${served[0]:0:10}\`, gateway \`${served[1]:0:10}\`, web \`${served[2]:0:10}\`)." '' \
      "Corrected by deploy run: ${run_url}. It replaces an earlier \"Not live on dev yet\".")"
    if gh api -X PATCH "repos/${repo}/issues/comments/${id}" -f body="$body" >/dev/null; then
      corrected+=("$number")
      summary+=("| #${number} | live (corrected) |")
    else
      warn "could not correct the comment on #${number}"
    fi
  done <<<"$candidates"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '%s\n' "${summary[@]}" '' '| Surface | Result |' '|---|---|' "${rows[@]}" >>"$GITHUB_STEP_SUMMARY"
fi
echo "announce-dev-live: $([ "$live" = true ] && echo live || echo 'not live') → ${prs[*]}${corrected[0]:+; corrected: ${corrected[*]}}"
