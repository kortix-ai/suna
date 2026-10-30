---
recorded: 2026-10-30T02:36:45Z
incident_date: 2026-10-30
---
# Keep bootstrap service stubs in step with session-change registration

**Rule:** When bootstrap registers a new service callback, update its isolated service stub and assert registration rather than dropping the callback.

**Trigger surface:** Changing bootstrap service imports or the worker-enabled/API-only startup tests.

**Incident:** 2026-10-30: the v0.14.11 release suite failed both bootstrap worker tests because the broadcast stub lacked onSessionChanged. Production startup code already supplied that export.

**Enforcement:** apps/api/src/__tests__/unit-bootstrap-workers.test.ts exercises bootServices in both modes and asserts session-change registration in the API-only mode.
