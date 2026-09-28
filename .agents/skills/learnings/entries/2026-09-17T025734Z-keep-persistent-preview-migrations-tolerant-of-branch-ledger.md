---
recorded: 2026-09-17T02:57:34Z
incident_date: 2026-09-17
commit: a638e53b4f
---
# Keep persistent preview migrations tolerant of branch ledger order

**When:** redeploying a branch preview after merging `main`. The preview keeps
its database. A new `main` migration can have an earlier filename than a branch
migration already applied there. Use `preview-up` only in the preview compose
overlay; keep the strict `bootstrap` command for self-host and releases.

**Incident (PR #7319):** run `35171925192` failed before the preview API could
start. Its DB had pooled migration `20260916194914446` before newly merged
managed GitHub migration `20260916184801110`.

**Enforcement:** `preview-up` requires the preview marker and `supabase-db` host.
The preview compose test pins the command. Migration target tests pin its guard.
