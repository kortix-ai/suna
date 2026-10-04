---
recorded: 2026-09-29T09:48:02Z
incident_date: 2026-09-29
---
# When a writer gains an optional form, update every reader that recognizes its output

**Rule:** When a writer can emit a second form of a string (here, an optional `attachment="kortix-attachment://…"` attribute on a file reference), find every reader that matches that string exactly and teach it the new form in the same change. Test each reader with every form the writer emits.

**Trigger surface:** Changing `promptFileReferenceXml` or `materializePromptAttachments` in `apps/api`, or any code that recognizes text the platform wrote earlier (`legacy-inline-attachment-repair.ts` compares runtime parts to the reference a delivery wrote).

**Incident:** 2026-09-29, a near-miss found while removing the `session_transcript_history` flag. Delivery named each file's saved copy in its reference, but the legacy repair matched only the reference without it. It threw "does not map to one runtime part" and kept every later prompt of the session queued. That happened only when the repair marker write had failed after the first prompt. No production report.

**Enforcement:** `apps/api/src/services/sessions/lifecycle/legacy-inline-attachment-repair.test.ts` ("recognizes command-key XML that names its saved copy"), and the two pending-first recovery tests in `__tests__/queued-continue-inbox-delivery.test.ts`, which now always deliver with a saved copy.
