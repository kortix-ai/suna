---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-16
commit: cea48e1b66
---
# Restore the startup composer from the durable first prompt

**Incident.** Reloading a preview session during its first sandbox startup lost the
tab's local handoff. The full-screen loader hid accepted prompts and queue editing.

**Rule.** A durable first prompt is sufficient evidence to restore the startup
composer. Existing transcript content still takes precedence. Local navigation
hints cannot be the only source of startup presentation state.

**Enforcer.** `session-surface.test.ts` covers durable-first-prompt restoration and
the transcript veto. The queue journey in `27-desktop-parity.spec.ts` reloads a
starting session and asserts that its accepted prompt and composer remain visible.
