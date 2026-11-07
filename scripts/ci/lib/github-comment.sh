# Sourced by the CI comment scripts; not executable on its own.
# A sticky comment is the one pull-request comment whose body starts with a marker.

# sticky_comment <repo> <num> <marker>: the comment as compact JSON, or nothing.
sticky_comment() {
  gh api --paginate "repos/${1}/issues/${2}/comments" 2>/dev/null \
    | jq -cs --arg m "$3" '[.[][] | select(.body | startswith($m))][0] // empty' 2>/dev/null || true
}

# sticky_comment_id <repo> <num> <marker>: its id, or nothing.
sticky_comment_id() {
  sticky_comment "$@" | jq -r '.id // empty' 2>/dev/null || true
}

# upsert_sticky_comment <repo> <num> <marker> <body>: PATCH the comment when it
# exists, POST a new one otherwise. Returns 3 when the PATCH failed and 4 when
# the POST failed, so each caller keeps its own warning text.
upsert_sticky_comment() {
  local id
  id="$(sticky_comment_id "$1" "$2" "$3")"
  if [ -n "$id" ]; then
    gh api -X PATCH "repos/${1}/issues/comments/${id}" -f body="$4" >/dev/null || return 3
  else
    gh api -X POST "repos/${1}/issues/${2}/comments" -f body="$4" >/dev/null || return 4
  fi
}
