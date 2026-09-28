---
recorded: 2026-09-14T22:57:10Z
incident_date: 2026-09-14
commit: f5efb6316c
---
# Validate the destination against an exact-file permission, not its parent

**When:** validating Computer Tunnel writes. Resolve both the destination and
missing allowlist paths through their nearest existing ancestor. Compare the full
resolved destination with the allowlist. An approved file does not grant its parent.
*Incident:* XLSX follow-up CI exposed rejected exact-file approvals; macOS also
compared `/var` with `/private/var` for missing files. *Enforcers:*
`filesystem-integrity.test.ts` and `TUN-6` with an exact-file permission.
