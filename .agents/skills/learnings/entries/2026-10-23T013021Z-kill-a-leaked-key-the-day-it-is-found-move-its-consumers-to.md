---
recorded: 2026-10-23T01:30:21Z
incident_date: 2026-10-23
---
# Kill a leaked key the day it is found: move its consumers to the new key, disable the old one, verify it returns 401

**Rule:** When a key is found leaked, the same day: find every consumer (compare SHA-256 prefixes, never print values), move each to the new key, disable the old key at the provider, and verify the old key returns `401`. An open secret-scanning alert is an incident with an owner, not a backlog item.

**Trigger surface:** A GitHub secret-scanning alert, a key in a public commit, a Supabase legacy-key rollover, or any rotation that leaves the old key enabled "for now".

**Incident:** 2026-04-01: alert suna #3 (and computer #2) flagged a Supabase legacy `service_role` key for the DEV project, committed in `sandbox/test_cloud_proxy.py` (commit 29f0ea98a9). The alert stayed open ~6.5 months. On 2026-10-23 the key still returned `200` on DEV REST and auth admin (full admin access to DEV data and users). The prod rollover of 2026-10-21 moved envs to `sb_` keys but left legacy keys enabled, and AWS `kortix-preview-env` still used the leaked key. Fix, 2026-10-23: `kortix-preview-env` moved to the DEV `sb_secret` key, local mobile env to `sb_publishable`, legacy API keys disabled at 01:26:39 UTC (`PUT /v1/projects/{ref}/api-keys/legacy?enabled=false`), leaked key `401` at 01:28:39 UTC (~2 min propagation). Linear KRTX-3266. Open: installed mobile dev builds embed the legacy anon key (rebuild needed); the PR #9164 preview runs the old key until redeployed; prod legacy keys stay enabled pending mobile traffic (separate track).

**Enforcement:** Pending: the compliance loop in kortix-ai/company PR #276 flags any open secret-scanning alert at once (rule SS-1) and requires a `security-incident` Linear issue (IR-2). Until that PR merges this entry is a TODO, not a fact.
