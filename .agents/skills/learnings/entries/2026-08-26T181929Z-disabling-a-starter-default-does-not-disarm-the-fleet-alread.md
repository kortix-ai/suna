---
recorded: 2026-08-26T18:19:29Z
incident_date: 2026-08-26
commit: 82235c6856
---
# Disabling a starter default does not disarm the fleet already built from it

**When:** fixing runaway automation by editing `packages/starter/templates/`.
That edit only changes what NEW projects receive. Trigger rows are reconciled
from each project's OWN repo manifest, so every project created while the
default was enabled keeps firing. Ship the template fix AND a remediation for
the existing population in the same change, and say which one you verified.
*Incident:* PR #6806 disabled the 03:00 harness reflector on 2026-08-23 and
reached prod in v0.13.5; three nights later 766 projects still fired it and 654
sessions failed. Growth stopped at the fix; the standing population did not.
*Enforcer:* none — this is a review question, not a lint.
