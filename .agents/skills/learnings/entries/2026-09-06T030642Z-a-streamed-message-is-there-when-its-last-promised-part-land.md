---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-04
commit: 3caec60726
---
# A streamed message is "there" when its LAST promised part lands, not its first

**When:** swapping an optimistic/placeholder render for the runtime's own copy
of a message. The runtime streams a message's parts, TEXT FIRST — measured in a
real browser: file parts followed ~6 s later. The boot preview was released
"the frame the transcript shows the text", so for those seconds the bubble
went from three tiles + "Uploading 3 files…" to nothing under it, then the
tiles trickled back one by one. That frame is the user's bug report. **The
rule:** release the placeholder when the real copy carries at least what the
placeholder promised (text AND attachment count, counting materialized
`<file>` refs as attachments), or when the turn is answered (nothing more is
streaming). Measure such handovers with a per-second DOM probe, not a
screenshot at the end. *Enforcer:* `first-prompt-handover.test.ts`; the browser
probe in this incident's session showed `tiles=0` for two consecutive seconds
before the fix and none after.
