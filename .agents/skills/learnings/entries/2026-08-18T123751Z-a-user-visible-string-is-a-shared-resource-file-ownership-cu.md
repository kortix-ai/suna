---
recorded: 2026-08-18T12:37:51Z
incident_date: 2026-08-18
commit: 046727c037
---
# A user-visible string is a shared resource; file ownership cuts through it

**When:** any change that renames a label, error message, remedy or flag name —
especially work split across parallel agents by file ownership.

Renaming the network-boundary flag from "Network boundary without Platinum" to
"Network boundary in-guest shim" touched EIGHT files: the feature-flag registry
(which is what the Feature-flags screen actually renders), two route error
bodies, a provisioning-error remedy, its test, two docs pages and the web
constant. An agent that owned only the web file renamed it there and nowhere
else. Nothing failed — no typecheck, no test, no lint — and the result would
have shipped a UI telling users to turn on a flag by a name the screen never
displays. The one guard that existed was a source-text assertion in a file the
agent did not own, which is what eventually caught a sibling change.

The rule: before renaming any user-visible string, grep the OLD string across
the whole repo (`--include='*.ts' --include='*.tsx' --include='*.md'
--include='*.mdx' --include='*.json'`) and change every hit in ONE commit. Then
grep it again and expect zero. A partial rename is worse than no rename: the old
name at least matched the UI.

Corollary for parallel agents: **file ownership is the wrong boundary for a
shared string.** Assign the whole rename to one agent, or do it yourself after
the fan-out lands. Two other same-shaped catches in the same batch — a test
pinning the exact `networkBoundaryEchoNotice(...)` call site, and one pinning
the exact `sudo -u kortix --` invocation — both lived in files the changing
agent did not own, and both only surfaced in CI. Reproducing CI's own command
locally (`pnpm --filter ./packages/** --filter ./apps/** … test`) found them in
one pass instead of one CI round-trip each.
*Incident:* PR #6511, caught in review before merge; two CI round-trips spent.
