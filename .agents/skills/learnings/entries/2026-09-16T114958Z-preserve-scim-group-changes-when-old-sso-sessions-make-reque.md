---
recorded: 2026-09-16T11:49:58Z
incident_date: 2026-09-16
commit: 223ae4eace
---
# Preserve SCIM group changes when old SSO sessions make requests

**When:** reconciling SAML group claims. Leave SCIM-managed groups to SCIM. Mark
existing groups as SCIM-managed when the provisioning API takes ownership.
*Incident:* Azure added Ivan to Engineering on dev; reloading his older SSO
session deleted the membership. Pathless group attributes also returned success
without persisting. *Enforcer:* `SCIM-8` uses real signed Supabase tokens to
prove old claims cannot undo SCIM additions or removals, and checks read-back.
