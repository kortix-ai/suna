---
recorded: 2026-10-30T10:08:03Z
incident_date: 2026-10-30
---
# Isolate native test profiles and confirm process exit

**Rule:** Create and record a private per-run Electron profile before launch. Set `KORTIX_DESKTOP_USER_DATA` explicitly. Record the native PID before fixture writes. Confirm process exit before deleting fixture resources or that profile.

**Trigger surface:** Native desktop verification through Electron or the real desktop application.

**Incident:** One HTML verification attempt used Electron's default profile. Its native process exited and all API resources were removed. Scoped cleanup removed only the fixture user's matching local-storage value. No matching fixture auth cookie existed. The shared profile and unrelated state remained untouched. Later runs used private temporary profiles and verified native exit before cleanup.

**Enforcement:** `apps/desktop-electron/src/computer.test.js` covers the user-data override. The verification controller records the profile and native PID before writes. Its cleanup refuses destructive teardown until native exit is confirmed. A failed launch retains its ownership receipt until independent process/profile checks reconcile it.
