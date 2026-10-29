# Private channels rollout

Private channels are channels with `kortix.project_spaces.visibility = 'private'`.
Only their members see their threads, files, memory, links and Apps. The
switch is the API env var `KORTIX_PRIVATE_CHANNELS_ENABLED` (`apps/api/src/config.ts`,
default off). While it is off, creating a private channel or converting a
public one answers `409 private_channels_unavailable`
(`privateChannelsAvailable()`, `apps/api/src/shared/space-access.ts`).

## Why the switch exists

- An API build from before private channels ignores `visibility`. Such a build
  shows every private channel and its threads to every project member.
- A rollback to such a build, or a mixed-version deploy, leaks once one private
  row exists.
- The switch is an env var, never a code constant, so each environment turns it
  on on purpose.

## When to turn it on

Turn it on in an environment only when both are true:

1. Every API build still deployed there, or reachable by `kortix-rollback`,
   enforces private channels.
2. Trigger delivery into a private channel works on that environment.

After it is on, never roll that environment back below the build that turned it
on while any private channel exists. Turning the env var off stops new private
channels. It does not hide existing ones from an older build.

## Checklist for the change that turns it on

- [ ] Set the env var per environment: dev, then staging, then prod. Never as a
      code default.
- [ ] Confirm every API build still deployed, or reachable by `kortix-rollback`,
      is this build or newer.
- [ ] Put this text in the release notes of the release that turns it on:
      > Private channels: a channel can be private at creation, or a public
      > channel can be made private by its creator or a project manager. Only
      > its members see its threads, files, memory, links and Apps. Code
      > changes (git branches) and the agents' own tools aren't private. A
      > private channel cannot be made public again. Operators: do not roll the
      > API back below this release while any private channel exists. An older
      > build shows private channels to every project member. Turning
      > `KORTIX_PRIVATE_CHANNELS_ENABLED` off stops new private channels but
      > does not hide existing ones from an older build.
- [ ] Add a step to the `kortix-rollback` skill, before it chooses a target:
      > If the target is older than the release that turned on private
      > channels, run `select count(*) from kortix.project_spaces where
      > visibility = 'private'` on that environment's database. A count above 0
      > refuses the rollback: roll forward instead, or get the owner's written
      > approval to expose private channels.
- [ ] Check that the revocation windows in the `project_channels`
      `enforcementNote` (`apps/api/src/feature-flags/registry.ts`) are current.
- [ ] Keep the accepted limits listed in the release notes and the PR body:
  - A member of a private channel may publish one of its threads with a public
    share link; an agent may not.
  - Access ends within cache windows after a removal: REST up to 10 s on another
    replica, streams up to 60 s, an artifact view URL up to 18 h.
  - A manager outside a private channel sees its audit rows as metadata only
    (who, what action, when, outcome).
  - Agent config, skills, MCP tools and network egress are not private, and a
    private thread's git branch is readable like any branch.
  - On boxes with `KORTIX_DRIVES_SYNC=on`, a removed member's drive-sync
    credential keeps its mounts until the box restarts, and files from before a
    conversion can upload again. Fix both before turning the env var on there.
  - A conversion that fails because both `/Company/Channels/<slug>` and
    `/Channels/<space_id>` exist answers `503 folder_move_failed` on every
    retry until one folder is removed by hand.
