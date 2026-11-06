---
recorded: 2026-11-05T19:09:25Z
incident_date: 2026-11-05
---
# Count a not-mixed-version-safe migration's window until the old API tasks stop, not until the deploy job ends

**Rule:** When a migration breaks the previous API version on purpose (a
`mixed-version-safe: NOT safe` annotation), measure and announce the outage
from the migration commit until the last old API task has STOPPED, not until
the deploy job turns green. Expect a prompt or command handled by an old task
in that time to be dead-lettered, not delayed, and plan what happens to it
(the user resends, or a post-rollout re-drive).

**Trigger surface:** Writing or releasing a migration that renames or drops
something the previous version still names; reading "deploy succeeded" as
"the old code is gone".

**Incident:** 2026-11-05, #11848 renamed `opencode_session_id` and two more
columns in one release (owner accepted the downtime). Dev deploy run
42085300856: migrations done 18:39:48Z; the old API answered `500` on the
session list until 18:55:40Z. The deploy job's API roll waits only for
`serving` and reported success at 18:55:48Z, but the last old task drained
until the deployment completed at 18:56:44Z and kept running its command
loop. A prompt sent at 18:56:37Z was picked by that old task, failed 5 times
on the old column in 21 s, and was dead-lettered (`session_lifecycle_commands`
status `dead_lettered`); the CLI timed out waiting for the reply. Resending it
after the drain worked. No customer data was affected (dev, internal project).

**Enforcement:** none yet: a not-mixed-version-safe migration should come
with a post-rollout step that lists the lifecycle commands dead-lettered with
an undefined-column error during the window (and the turns it left open), so
the release driver can re-drive or close them.
