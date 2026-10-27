---
recorded: 2026-10-27T15:25:14Z
incident_date: 2026-10-27
---
# Handle PDF selection clipboard denial in the host subscriber

**Rule:** Register the framework-free selection plugin and one host clipboard subscriber. Use the shared boolean clipboard helper and show an error toast on denial.

**Trigger surface:** PDF text-selection copy and selection-plugin upgrades.

**Incident:** On 2026-10-27, one production Firefox event reported an unhandled `NotAllowedError`. The upstream React selection package installs a utility that discards the clipboard promise. The viewer also mounted that utility explicitly, creating two subscribers.

**Enforcement:** `packages/ui/src/files/renderers/pdf/pdf-clipboard.test.tsx` exercises denied and successful writes and subscription cleanup. The denied case fails with the upstream utility.
