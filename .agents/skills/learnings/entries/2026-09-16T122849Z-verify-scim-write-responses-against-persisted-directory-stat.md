---
recorded: 2026-09-16T12:28:49Z
commit: 1cdff9ef95
---
# Verify SCIM write responses against persisted directory state

**Incident (2026-09-16, PR #7298):** group `Replace Members` and user
`name.givenName` updates returned HTTP 200 while retaining the old values.
Malformed group operations could also leave an earlier operation applied.

**Rule:** validate complete SCIM changes before applying them. Apply a request
atomically and verify GET read-back. Support case-insensitive attribute names,
Entra subattribute paths, stable pagination, and escaped equality filters.

**Enforcement:** HTTP flows `SCIM-11` and `SCIM-12` assert persisted values,
rollback, rejection of malformed requests, and pagination. `SCIM-13` verifies
account isolation, last-owner guards, and provisioning-token revocation.
