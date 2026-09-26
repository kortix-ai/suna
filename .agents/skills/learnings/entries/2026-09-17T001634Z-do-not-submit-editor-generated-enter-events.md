---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-16
commit: cea48e1b66
---
# Do not submit editor-generated Enter events

**Incident.** The session queue browser regression inserted multiline text. ProseMirror
synthesized a plain Enter event during DOM reconciliation. The composer submitted it
before the user's modified Enter, choosing transcript placement and consuming the draft.

**Rule.** Submission requires an explicit keyboard modifier state (`shiftKey === false`).
ProseMirror's plain events have no modifier fields. They must not invoke submission.
Exercise modified Enter with real typed line breaks, not only callback unit tests.

**Enforcer.** `composer-editor.test.ts` rejects the synthetic event. The queue journey
in `27-desktop-parity.spec.ts` types code with Shift+Enter, submits with Control+Enter,
and asserts the request, persisted text, reload, and visible composer placement.
