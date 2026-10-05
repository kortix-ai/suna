---
recorded: 2026-09-14T22:57:10Z
incident_date: 2026-09-14
commit: f5efb6316c
---
# Transfer opaque bytes programmatically and verify the destination digest

**When:** sending binary artifacts through Computer Tunnel. Never transcribe base64
from model context. Use `fs_upload`, or generate at the destination. Validate format
at the source; compare SHA-256 after transfer. Reject malformed file arguments before
creating permission requests. Resolve approve/deny with a pending-state conditional update.
*Incident:* XLSX transfer to a Mac produced identical same-length corrupt copies;
an approval denial also conflicted with a reported write. That historical race is unproven.
*Enforcers:* `filesystem-integrity.test.ts` and product flow `TUN-6`.
