---
recorded: 2026-09-25T21:51:30Z
incident_date: 2026-09-25
---
# Redact external signal text by allowlist before an agent writes it to Linear or GitHub

**Rule:** When an agent copies text from an external signal (Better Stack errors,
logs, uptime, Sentry events) into a Linear issue, PR, or comment, pass every field
through an allowlist: keep only values that match a known-safe shape (repo and package
code paths, bundle chunk paths), and collapse everything else to a class placeholder
(`app:///<page>`, `<non-code>`, `<id>`). Never rely on a denylist of emails and UUIDs.
Before a new producer merges, replay real captured signal data through it, not only
synthetic fixtures.

**Trigger surface:** writing or changing a software-factory source (company repo,
`software-factory-*` skills) or any automation that files issues or PRs from telemetry.

**Incident:** 2026-09-25, company PR #37. The infra sweep copied Better Stack "call
sites" into Linear verbatim. They included page URLs with a real `<project_id>` and
`<session_id>`, and a customer's GitHub org and repo name. 9 issues carried such text
before the fix (company PR #38) and a scrub; the trigger was paused for about 1 hour.
A workflow verifier found it by replaying live data after the merge.

**Enforcement:** `safeCallSite` tests in the company repo
(`software-factory-infra-sweep/references/errors.test.ts`) fail when a page URL or a
git-error fragment reaches an issue title, body, or evidence line. None yet for other
producers: a shared redaction helper with the same test.
