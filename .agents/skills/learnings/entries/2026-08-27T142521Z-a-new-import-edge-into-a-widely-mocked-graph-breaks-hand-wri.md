---
recorded: 2026-08-27T14:25:21Z
incident_date: 2026-08-27
commit: 70bfca102c
---
# A new import edge into a widely-mocked graph breaks hand-written module mocks all over the suite — and the failure names no test

**When:** adding an import to code that many suites exercise (a middleware, a
proxy, a gate). `mock.module` replaces a module **WHOLESALE**, so every suite
that stubs a module by listing its exports silently deletes the ones it did not
name. Pull that module into a new part of the graph and those missing names
become `SyntaxError: Export named 'X' not found in module …`, printed as
`# Unhandled error between tests` — attributed to NO test, and it takes an
unrelated parallel worker down with it, so the visible symptom is a stranger's
suite failing.

Fix them one at a time and it cascades: `loadTokenBinding` →
`ensureAgentServiceAccount` → `createAccountToken` →
`resolveInheritedSessionSharing`, each spread pulling the next real module in.

**The rule: fix the import, not the mocks.** Ask what the new code actually
needs. Here the Apps gate wanted one email lookup and reached it through
`projects/lib/access`, which re-exports it from behind the whole
project/session/IAM read graph; `accounts/core/owner-emails` is the same
function with `drizzle` + `db` as its entire import list. One line, cascade
gone, zero test churn. Spread the real module (the 2026-08-18 rule) when you
own the mock and the dependency is genuinely needed — not as the way out of a
cascade you created.

**Diagnostic:** a suite that fails with `1 fail / 1 error` where the failing
test is in a file your branch never touched, and the run prints `1 tests
failed:` followed by nothing, is this. Read the `Unhandled error` block, not the
failing test name.
*Near-miss:* PR #6963 (the Apps viewer token). Cost two CI rounds and a wrong
"it's a pre-existing flake" call before the real cause was read.
*Recurrence, same day:* `d990e122aa` added `ensurePiWorkerImage` to the static
import from `snapshots/builder` in `platform/services/session-sandbox.ts`. The
module edge already existed — only the NAME was new — and that was enough: all
eleven suites that stub `snapshots/builder` by listing its exports died at
import. It reddened the packages lane on two unrelated PRs (#6978, and #6957 on
different tests) before anyone read the cause. Fixed in #6982 by deferring that
one name to a dynamic import at its single call site: zero mock churn.
**It does not reproduce locally** — the full `apps/api` suite passes 8745/0 both
with and without the fix. Only CI's worker count and interleaving surface it, so
"it passes on my machine" proves nothing about this class. Read the CI
`Unhandled error` block.
*Enforcer:* none. A lint that flags `mock.module` factories which do not spread
the real module would catch the mocks; nothing catches the import edge. Worth
building — this rule has now been paid for twice in one day.
