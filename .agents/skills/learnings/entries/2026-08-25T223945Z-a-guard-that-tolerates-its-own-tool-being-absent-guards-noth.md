---
recorded: 2026-08-25T22:39:45Z
incident_date: 2026-08-25
commit: 3aa4dfd0dd
---
# A guard that tolerates its own tool being absent guards nothing

**When:** writing any CI step of the form `if <tool> <pattern> … 2>/dev/null; then fail`.
If the tool is missing, the command fails, `2>/dev/null` hides why, the `if` reads
false, and the step prints its success line. Use a tool every runner image ships
(`grep`), or probe for it (`command -v rg || exit 2`) BEFORE the check; and pin
the pattern in one place the producer also uses (`GUARD_PATTERN_SOURCE` in
`tests/src/core/scrub.ts`), so the writer scrubs exactly what the guard greps.
*Incident:* `Guard test artifacts against secrets` in tests.yml / tests-release.yml /
tests-browser-nightly.yml called `rg`, which GitHub's ubuntu-24.04 image does not
ship. It reported "No secret-shaped values found." on every run since it was
written. The first Blacksmith run (image ships rg) failed it: 32 secret-shaped
values — 8 `kortix_pat_*`, `kortix_sa_*`, setup-link `{accountId,nonce,exp}`
tokens — inside the 73 MB `results.json` + `report.html` uploaded as PUBLIC
workflow artifacts on every PR (tokens of an ephemeral local stack; the
release gate would have uploaded STAGING tokens the same way). Fixed in the
Blacksmith follow-up PR: write-time shape scrub in `report.ts` (proven 32 → 0
on the real artifact) + grep-based guard.
*Enforcer:* `tests/unit/scrub-secret-shapes.test.ts` — scrubber vs guard
pattern parity, `writeResults` output passes the guard, and every guard step
uses `grep -rEIl "$pattern"` with the shared pattern, never `rg`.
