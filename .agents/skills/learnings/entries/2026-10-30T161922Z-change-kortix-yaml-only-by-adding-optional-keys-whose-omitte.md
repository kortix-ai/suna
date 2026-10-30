---
recorded: 2026-10-30T16:19:22Z
incident_date: 2026-10-30
supersedes: 2026-10-16T194431Z-gate-every-new-manifest-key-on-kortix-version-and-prove-a-sc.md
---
# Change kortix.yaml only by adding optional keys whose omitted value keeps today's behavior; never gate a key on a version

**Rule:** kortix.yaml has one format and no version. Add a key only as optional, with an omitted value that means what the file means today. Never change what a missing key means, and never branch on `kortix_version`. To replace a shape, add an entry to `DEPRECATIONS` (`packages/manifest-schema/src/deprecations.ts`) whose rewrite keeps the meaning, plus a case in `deprecations.test.ts` and a row in the docs table: the old shape keeps working, readers see the latest shape, writers save it. A breaking change is never made in place. The superseded entry's second half still holds: before a promote, compile each project class on the prod tree and on dev and diff the compiled governance.

**Trigger surface:** Editing `packages/manifest-schema` or any reader or writer of kortix.yaml (`apps/api/src/projects/lib/compile-agent-config.ts`, `manifest-io.ts`, the CLI writers, the starter).

**Incident:** 2026-10-30, branch `one-schema`: v1, v2 and TOML were removed and the version line dropped. The 2026-10-16 near-miss (a v3 key leaking into v2) cannot recur: there is no second shape to leak into.

**Enforcement:** `packages/manifest-schema/src/__tests__/one-format.test.ts` (no version is valid, `2` is one error); `deprecations.test.ts` fails on a `DEPRECATIONS` entry without a case; `tests/unit/manifest-deprecations-doc.test.ts` fails on one without a docs row. The prod-vs-dev differential compile is still manual.
