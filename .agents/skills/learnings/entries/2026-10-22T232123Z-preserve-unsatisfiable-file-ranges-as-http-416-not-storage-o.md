---
recorded: 2026-10-22T23:21:23Z
incident_date: 2026-10-22
---
# Preserve unsatisfiable file ranges as HTTP 416, not storage outages

**Rule:** Preserve HTTP 416 and Content-Range when proxying file downloads. Do not classify an unsatisfiable client range as unavailable storage.

**Trigger surface:** Drive downloads through the storage adapter and API route.

**Incident:** 2026-10-22, KRTX-3215. Five production download range refusals became 503 errors because the adapter treated upstream 416 as an outage.

**Enforcement:** apps/api/src/drives/volumes-range.test.ts checks range forwarding, 416 and Content-Range preservation, successful statuses, and storage failure rejection.
