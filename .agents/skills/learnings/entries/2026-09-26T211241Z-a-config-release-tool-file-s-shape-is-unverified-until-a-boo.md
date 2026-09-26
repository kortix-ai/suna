---
recorded: 2026-09-26T21:12:41Z
incident_date: 2026-09-26
---
# A config-release tool file's shape is unverified until a booted proven check runs it

**Rule:** Give every `tools/*.ts` fixture used by a config-release test the real
OpenCode tool shape — `export default { description, args, execute() {…} }` (or the
`tool()` builder). Never write `export default {}` as a placeholder: OpenCode's
`/experimental/tool/ids` silently drops a tool with no `execute`, indistinguishable
from a genuinely missing file. `proven-check.ts` then correctly refuses the release
(`tools not loaded: <name>`) and falls back to `image-default` — the harness is
behaving correctly; the fixture is the defect.

**Trigger surface:** Writing or editing a `config-releases` test fixture (CFG-* flows,
`tests/src/flows/config-releases.flow.ts`) or any other fixture whose `tools/*.ts` file
is asserted to load into a real, booted OpenCode instance.

**Incident:** 2026-09-26, release gate for a config-release feature. The gate's only
two box-backed flows (`requires: funded, daytona`; every other flow in the same suite
fakes OpenCode and cannot catch this) failed identically at their first assertion:
`the box is not on a proven release … fallback_reason: "release … failed: tools not
loaded: hello"`. Root-caused on a real Platinum sandbox: a bare `export default {}`
never registers under `/experimental/tool/ids`, on ANY OpenCode version, with NO
sealed-boot-dir or archival cause — fixed by giving the fixture's `hello.ts` a real
`{description, args, execute}` shape (PR #7767). Independently re-verified end to end
on a fresh throwaway dev project: before the fix, `GET …/sessions/:id/config` reported
`source: "image-default"` and the same `fallback_reason`; after, `running_release_id
=== desired_release_id`, `source: "release"`, `proven: true`, `fallback_reason: null`.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/proven-check-causes.test.ts`
now pins the contract at the unit level (a tool that answers 200 but never registers
under its own name IS `tools not loaded`, a default vs. named export registers under
`<name>` vs. `<name>_<export>`) — a regression to this class no longer needs a live box
to surface locally. `CFG-11`/`CFG-12` (`requires: funded, daytona`) remain the box-level
gate; they self-skip on the local profile, so they only run via a deployed target (the
release gate, or the `preview` label's full self-host).
