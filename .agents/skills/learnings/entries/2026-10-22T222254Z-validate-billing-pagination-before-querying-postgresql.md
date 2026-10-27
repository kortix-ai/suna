---
recorded: 2026-10-22T22:22:54Z
incident_date: 2026-10-22
---
# Validate billing pagination before querying PostgreSQL

**Rule:** Require nonnegative safe integers for billing pagination before querying the ledger.

**Trigger surface:** Transaction and credit-usage list query schemas.

**Incident:** KRTX-3175: prod 0.14.6 returned six transaction 5xx responses in the incident hour. PostgreSQL reported 2201X. The local HTTP reproduction with offset=-1 returned 500 and OFFSET must not be negative.

**Enforcement:** BILL-5 sends negative, fractional and unsafe limit/offset values to both billing list routes and requires HTTP 400.
