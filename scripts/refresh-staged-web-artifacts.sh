#!/bin/sh
# Generate only from fully staged inputs; never stash or stage source edits.
set -eu
staged=$(git diff --cached --name-only --no-renames --diff-filter=ACMD)
content='^apps/web/(content/|src/app/|src/features/marketing/|scripts/build-content-timestamps\.mjs$)'
routes='^(tests/spec/routes\.generated\.json|apps/web/scripts/generate-audit-http-routes\.mjs)$'
# Every input of the audit-actions reference doc: the label catalog it renders,
# the generator, and the feature-flag defaults that hide flagged actions. A
# labels change that lands without the regenerated doc is the recurring
# KRTX-3743/KRTX-3758 defect (the doc's guard test only fails after the merge).
audit='^(packages/shared/src/audit-(labels|route-labels|event-labels)\.ts|apps/web/scripts/(generate-audit-actions-doc|docs-generated-region)\.mjs|apps/api/src/feature-flags/registry\.ts)$'
outputs=''
if printf '%s\n' "$staged" | grep -qE "$content"; then
  outputs='apps/web/src/lib/seo/content-timestamps.json'
fi
if printf '%s\n' "$staged" | grep -qE "$routes"; then
  outputs="$outputs apps/web/src/components/iam/audit-http-routes.generated.ts"
fi
if printf '%s\n' "$staged" | grep -qE "$audit"; then
  outputs="$outputs apps/web/content/docs/audit-actions.mdx"
fi
[ -n "$outputs" ] || exit 0

# A generator reads the working tree. Refuse partial staging before any runs.
# The doc output is under apps/web/content/, so $content already refuses it.
if git diff --name-only --no-renames | grep -qE "$content|$routes|$audit|^apps/web/src/lib/seo/content-timestamps\.json$|^apps/web/src/components/iam/audit-http-routes\.generated\.ts$" \
  || git ls-files --others --exclude-standard | grep -qE "$content|$routes|$audit"; then
  echo 'pre-commit: web artifact inputs/outputs have unstaged changes. Stage or save them separately, then retry.' >&2
  exit 1
fi
for output in $outputs; do
  case "$output" in
    *content-timestamps.json) node apps/web/scripts/build-content-timestamps.mjs --strict ;;
    *audit-http-routes.generated.ts) node apps/web/scripts/generate-audit-http-routes.mjs ;;
    *audit-actions.mdx)
      # The generator imports the .ts label catalog, which only bun resolves.
      if command -v bun >/dev/null 2>&1; then
        bun apps/web/scripts/generate-audit-actions-doc.mjs
      else
        echo 'pre-commit: bun is not on PATH — regenerate the audit-actions doc and stage it:' >&2
        echo '  bun apps/web/scripts/generate-audit-actions-doc.mjs' >&2
        exit 1
      fi ;;
  esac
done
# Stage only after every generator succeeds.
git add -- $outputs
