---
name: kortix-channel-memory
description: "A channel's or DM's own memory: the folder named in the channel (or DM) section of `/drives/README.md`. Shared with the project in a channel, private to the user in a DM. Load at the start of a thread in a channel or DM, and when you learn something the next thread there should know."
metadata:
  kortix-feature-flag: project_channels
---

<skill name="kortix-channel-memory">

<channels>
A thread in a channel or a DM has one more memory: the space's own. Its
path is in the "This thread's channel" (or DM) section of
`/drives/README.md`. That path is the one to use. `KORTIX_SPACE_KIND` /
`KORTIX_SPACE_SLUG` say which space the thread started in
(`KORTIX_SPACE_SLUG` is the agent's name in a DM). They do not change when
a channel is renamed, so never build a path from them. A thread can also
have the README section without these variables.

- **Channel**: `/drives/company/Channels/<slug>/Memory/`. Shared with
  everyone in the project. Keep what the next thread in this channel should
  know: decisions, conventions, open work. Never a person's private facts.
- **DM**: `/drives/me/Memory/agents/<agent>/`. Private to the user, for
  your work with them as this agent.

Read the space memory's `MEMORY.md` at the start of the thread, next to the
user's own. Write durable facts there in the same turn: a `MEMORY.md`
index and topic files, in the style of the `kortix-user-memory` skill. The user's own facts still go in
`/drives/me/Memory/`. Create a missing memory folder only at the path the
README names. When the README has no such section, the thread has no space
memory: do not invent a path.
</channels>

</skill>
