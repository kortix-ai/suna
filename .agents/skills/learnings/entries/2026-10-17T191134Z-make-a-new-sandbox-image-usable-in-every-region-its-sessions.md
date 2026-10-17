---
recorded: 2026-10-17T19:11:34Z
incident_date: 2026-10-17
---
# Make a new sandbox image usable in every region its sessions boot in before you point the template at it

**Rule:** A template build is not finished when the provider says `ready` in its home region. A project with `us_region` boots in another region. Copy the image there (`preparePlatinumTemplateRegion`) before `recordTemplateBuilt` points the row at it and reaps the predecessor. Until the copy is done, a boot serves the last ready image.

**Trigger surface:** `apps/api/src/snapshots/builder.ts` (`ensureSandboxImage`, `runInlineBuild`), the predecessor reap in `snapshots/templates.ts`, and any new region or provider placement option.

**Incident:** 2026-10-17. On a self-host box, a `:stable` update changed the template identity. The rebuild finished at 19:00:33Z; the row flipped and the previous image was deleted at 19:00:34Z. The next session booted the new image in `us-east`, where Platinum was still copying it: 7 creates, each refused `409 template_not_resident (replicating)`, 79.6 s instead of ~2.3 s. The same pattern cost 99.6 s (8 attempts) at 06:27Z that day. The failed attempts left no error in `provider_events`, only `attempts=7`.

**Enforcement:** `apps/api/src/snapshots/builder-region-resident.test.ts` pins `templateRegionResident`. The build path awaits it before `recordTemplateBuilt`; the boot path checks it for 3 s and falls back to the last ready image.
