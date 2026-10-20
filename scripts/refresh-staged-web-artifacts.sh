#!/bin/sh
# Generate only from fully staged inputs; never stash or stage source edits.
set -eu
staged=$(git diff --cached --name-only --no-renames --diff-filter=ACMD)
content='^apps/web/(content/|src/app/|src/features/marketing/|scripts/build-content-timestamps\.mjs$)'
routes='^(tests/spec/routes\.generated\.json|apps/web/scripts/generate-audit-http-routes\.mjs)$'
outputs=''
if printf '%s\n' "$staged" | grep -qE "$content"; then
  outputs='apps/web/src/lib/seo/content-timestamps.json'
fi
if printf '%s\n' "$staged" | grep -qE "$routes"; then
  outputs="$outputs apps/web/src/components/iam/audit-http-routes.generated.ts"
fi
[ -n "$outputs" ] || exit 0

# A generator reads the working tree. Refuse partial staging before either runs.
if git diff --name-only --no-renames | grep -qE "$content|$routes|^apps/web/src/lib/seo/content-timestamps\.json$|^apps/web/src/components/iam/audit-http-routes\.generated\.ts$" \
  || git ls-files --others --exclude-standard | grep -qE "$content|$routes"; then
  echo 'pre-commit: web artifact inputs/outputs have unstaged changes. Stage or save them separately, then retry.' >&2
  exit 1
fi
for output in $outputs; do
  case "$output" in
    *content-timestamps.json) node apps/web/scripts/build-content-timestamps.mjs --strict ;;
    *audit-http-routes.generated.ts) node apps/web/scripts/generate-audit-http-routes.mjs ;;
  esac
done
# Stage only after every generator succeeds.
git add -- $outputs
