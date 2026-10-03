# Sourced by a test runner (apps/api/scripts/test.sh, apps/cli/scripts/test.sh)
# before it spawns its suite: present a developer box to the tests.
#
# A runtime box — a session sandbox, a worker container — exports the live
# session's KORTIX_* variables and carries the image's baked assets, and suites
# that spawn the CLI or a daemon pass that state straight through (2026-10-03:
# the API connector/compile batches and the CLI suite read the box's identity
# and failed on values only a runtime box has). Strip the ambient runtime
# environment and point every baked asset at an absent path, so a spawned
# child behaves exactly as on a developer box, where none of it exists.
# A suite that passes its own env-file (apps/api's hermetic test.env) applies
# it afterwards, so the file's values still win.
#
# The bunfig-level part of the same isolation — the `localhost` fetch shim —
# is scripts/isolated-localhost.ts.
_kortix_test_box="${TMPDIR:-/tmp}/kortix-test-box-$$"
mkdir -p "$_kortix_test_box/managed-skills" "$_kortix_test_box/agent-state"
while IFS= read -r _kortix_name; do unset "$_kortix_name"; done <<-_KORTIX_AMBIENT
$(env | sed -n 's/^\(KORTIX_[A-Za-z0-9_]*\)=.*/\1/p')
_KORTIX_AMBIENT
export KORTIX_MANAGED_SKILLS_DIR="$_kortix_test_box/managed-skills"
export KORTIX_AGENT_STATE_DIR="$_kortix_test_box/agent-state"
export KORTIX_AGENT_BIN="$_kortix_test_box/agent-bin"
export KORTIX_SCAFFOLD_REPO_PATH="$_kortix_test_box/scaffold.git"
export KORTIX_BAKED_LLM_CATALOG_PATH="$_kortix_test_box/llm-catalog.json"
export KORTIX_PT_ENV_PATH="$_kortix_test_box/pt-env"
unset _kortix_test_box _kortix_name
