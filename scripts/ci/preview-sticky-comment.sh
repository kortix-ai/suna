#!/usr/bin/env bash
#
# preview-sticky-comment.sh — write the one `<!-- preview-status -->` comment a
# preview-labelled pull request carries, from the deploy job's step outcomes.
#
# deploy-preview.yml calls it twice: right after the deploy step, so the origin
# is on the pull request while `pnpm test -- --target-full` still runs, and at
# the end with the suite's outcome. It says "tested" only when the suite step
# itself succeeded.
#
# Environment:
#   GITHUB_REPOSITORY, NUM, COMMIT, RUN_URL
#   PREVIEW_URL, REPORT_URL, PROVIDER, SANDBOX_ID   deploy/suite step outputs
#   DEPLOY_OUTCOME   outcome of the deploy step (success | failure | …)
#   SUITE            1 when this run tests (the deploy's `suite` output)
#   SUITE_OUTCOME    empty while the suite runs; else the suite step outcome
#
# Never fails the job: a GitHub API error becomes a ::warning:: and exit 0.

set -euo pipefail

marker='<!-- preview-status -->'
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
num="${NUM:?NUM required}"
report="${REPORT_URL:-}"

if [ "${DEPLOY_OUTCOME:-}" != success ]; then
  title='## Preview environment - deployment failed'
  if [ -n "${PREVIEW_URL:-}" ]; then
    result='The stack did not prove healthy on this commit. The sandbox stays up for diagnosis. Open the workflow log.'
  else
    result='No preview URL was published. Open the workflow log.'
  fi
  report="${report:-not run for this commit}"
elif [ "${SUITE:-0}" != 1 ]; then
  # The suite is the GATE, and a redeploy from a push deliberately skips it
  # (PREVIEW_RUN_TESTS). This comment once read "live and tested" over a
  # deploy that ran nothing; saying so is the point of this branch.
  title='## Preview environment - live; NOT tested'
  # shellcheck disable=SC2016 # literal backticks are Markdown
  result='`pnpm test -- --target-full` did NOT run on this deploy — a redeploy from a push skips it. Re-run the workflow from the Actions tab, or re-apply the `preview` label, to test this commit.'
  report='not run for this commit'
else
  case "${SUITE_OUTCOME:-}" in
    '')
      title='## Preview environment - live; tests running'
      # shellcheck disable=SC2016
      result="\`pnpm test -- --target-full\` is running against this preview. This comment updates when it finishes: ${RUN_URL:-}"
      report='running'
      ;;
    success)
      title='## Preview environment - live and tested'
      # shellcheck disable=SC2016
      result='`pnpm test -- --target-full` passed.'
      ;;
    failure)
      title='## Preview environment - live; tests failed'
      result='The preview stays available for diagnosis. Open the report and the workflow log.'
      ;;
    *)
      title='## Preview environment - live; tests did not finish'
      result="The suite step ended as ${SUITE_OUTCOME}. The preview stays available. Re-run the workflow to test this commit."
      ;;
  esac
  report="${report:-not published}"
fi

body="$(printf '%s\n' "$marker" "$title" '' \
  "- **Preview:** ${PREVIEW_URL:-unavailable}" \
  "- **Test report:** ${report}" \
  "- **Provider:** ${PROVIDER:-${PREVIEW_SANDBOX_PROVIDER:-platinum}}" \
  "- **Sandbox:** ${SANDBOX_ID:-unavailable}" \
  "- **Commit:** \`${COMMIT:-unknown}\`" '' \
  "$result" '' \
  '_The preview owns PostgreSQL, Supabase, API, gateway, frontend, and Mailpit. OAuth initiation is the only explicit preview exclusion._')"

id="$(gh api --paginate "repos/${repo}/issues/${num}/comments" 2>/dev/null \
  | jq -rs --arg m "$marker" '[.[][] | select(.body | startswith($m))][0].id // empty' 2>/dev/null || true)"
if [ -n "$id" ]; then
  gh api -X PATCH "repos/${repo}/issues/comments/${id}" -f body="$body" >/dev/null \
    || echo "::warning::could not edit the preview comment on #${num}"
else
  gh api -X POST "repos/${repo}/issues/${num}/comments" -f body="$body" >/dev/null \
    || echo "::warning::could not post the preview comment on #${num}"
fi
echo "preview comment: ${title#\#\# }"
