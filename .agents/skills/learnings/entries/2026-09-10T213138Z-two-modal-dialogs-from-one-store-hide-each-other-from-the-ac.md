---
recorded: 2026-09-10T21:31:38Z
incident_date: 2026-09-10
commit: b068d62921
---
# Two modal dialogs from one store hide each other from the accessibility tree

**When:** a dialog component is mounted defensively in more than one place
"so the button has a renderer". Radix marks the rest of the document
`aria-hidden` while a modal is open, so two instances hide each other: the
pixels are perfect and the a11y tree contains NEITHER. Screen readers are told
there is nothing there, and every role-based query finds nothing. Make the
component single-instance (first mount draws, the rest render null, next is
promoted on unmount) rather than trusting call sites not to overlap.
*Incident:* `GlobalUpgradeModal` was mounted in four places. Measured live on
dev: 3 dialogs, 2 of them the subscribe dialog, both `aria-hidden="true"`. It
failed the v0.13.13 release gate three times on staging against a screenshot
that plainly shows the dialog open, while the same click on dev sometimes
passed — which instance wins is a mount-order race. *Enforcer:*
`upgrade-modal-registry.test.ts`.
