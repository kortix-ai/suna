---
recorded: 2026-11-01T15:43:54Z
incident_date: 2026-11-01
---
# Never let one optional mount fail a box create: boot without it and attach it later

**Rule:** A box mounts its Files folders as optional volumes (`optionalVolumes`). A create that Platinum refuses over one of them boots again without it, on a new create attempt. The box records the folder as skipped with storage's reason, and the drive worker attaches it to the running box with backoff. Only the volumes that hold the box's own state (`/workspace`, an App machine's volume) may fail a create.

**Trigger surface:** Adding a volume to a sandbox create body, changing `PlatinumProvider.provisionFromTemplate` error handling, or a new Platinum mount refusal code.

**Incident:** 2026-11-01, prod. A team member put ~3.5 GB of video media in a shared Files folder. Platinum's sub_path image build for that folder hit its 2 GiB scratch budget (the folder cap is 10 GiB). Every create that mounted the folder answered `503 unavailable "deriving the sub_path image failed: … scratch image over budget"`. The body named neither "volume" nor "mount", so Kortix retried it 7 times as a generic provider error. 108 boxes of one project failed from 10:25 to ~15:45 UTC. No session of that project that mounted the folder could start. Platinum fixed the build in its PR #2412.

**Enforcement:** `apps/api/src/platform/providers/platinum-optional-volumes.test.ts` (each mount refusal boots without the folder on a new attempt, a required volume still fails, a full fleet drops nothing) and `apps/api/src/__tests__/integration-drive-boot-refused-folders.test.ts` (the drive worker attaches the folder later; a too-large folder is recorded once). The Platinum side adds a per-volume `required` flag (default true) so an optional mount never fails a create on the provider either.
