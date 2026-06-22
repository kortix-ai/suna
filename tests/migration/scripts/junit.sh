#!/usr/bin/env bash
# Minimal JUnit XML emitter for shell test cases. No host tooling needed.
#
# Usage:
#   source junit.sh
#   junit_init "migration.schema"
#   junit_case "key tables exist" pass
#   junit_case "rollback supported" fail "down migration errored: ..."
#   junit_write "${RESULTS_DIR}/schema.xml"

JUNIT_SUITE=""
JUNIT_CASES=()
JUNIT_FAILURES=0

_xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "$s"
}

junit_init() {
  JUNIT_SUITE="$1"
  JUNIT_CASES=()
  JUNIT_FAILURES=0
}

# junit_case <name> <pass|fail> [message]
junit_case() {
  local name; name="$(_xml_escape "$1")"
  local status="$2"
  local msg; msg="$(_xml_escape "${3:-}")"
  if [ "${status}" = "pass" ]; then
    JUNIT_CASES+=("<testcase name=\"${name}\" classname=\"${JUNIT_SUITE}\"/>")
    printf '\033[0;32m  PASS\033[0m %s\n' "$1"
  else
    JUNIT_FAILURES=$((JUNIT_FAILURES + 1))
    JUNIT_CASES+=("<testcase name=\"${name}\" classname=\"${JUNIT_SUITE}\"><failure message=\"${msg}\">${msg}</failure></testcase>")
    printf '\033[0;31m  FAIL\033[0m %s — %s\n' "$1" "${3:-}"
  fi
}

junit_write() {
  local out="$1"
  mkdir -p "$(dirname "${out}")"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites>\n'
    printf '  <testsuite name="%s" tests="%d" failures="%d">\n' \
      "$(_xml_escape "${JUNIT_SUITE}")" "${#JUNIT_CASES[@]}" "${JUNIT_FAILURES}"
    for c in "${JUNIT_CASES[@]}"; do
      printf '    %s\n' "$c"
    done
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } > "${out}"
  printf '\033[0;36m[migration]\033[0m wrote %s (%d cases, %d failures)\n' \
    "${out}" "${#JUNIT_CASES[@]}" "${JUNIT_FAILURES}"
}

junit_exit_code() {
  [ "${JUNIT_FAILURES}" -eq 0 ]
}
