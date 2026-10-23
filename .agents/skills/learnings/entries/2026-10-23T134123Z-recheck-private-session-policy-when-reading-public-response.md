---
recorded: 2026-10-23T13:41:23Z
incident_date: 2026-10-23
---
# Recheck private-session policy when reading public response snapshots

**Rule:** Check current personal connections and person-only secrets before serving a public response snapshot. Refuse anonymous reads with `410` when either requires privacy.

**Trigger surface:** Serving a previously published response after its session acquires private data access.

**Incident:** PR #10816 enforced the private-session rule at publication but not at anonymous read. A real HTTP regression created a personal connector binding after publication and received `200` instead of `410`. Caught before merge.

**Enforcement:** SESS-57 creates the binding, asserts publication returns `409` and anonymous read returns `410`, removes the binding, and asserts public access returns `200`.
