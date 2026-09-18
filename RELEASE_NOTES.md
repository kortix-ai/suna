Kortix in Microsoft Teams, a vision-capable model lineup, and attachments that stick

Kortix now works inside Microsoft Teams the way it works in Slack, the managed
model lineup moved to a vision-capable set with documented data residency, and
session attachments survive the whole session — including the very first
message.

## New

- **Microsoft Teams.** Run an agent from a channel, a group chat, or a direct
  message. Thread replies continue the same session without a new mention.
  Files work in both directions: inline images reach the agent, and results
  upload to the team drive with a link back. Join policies (open,
  owner-approval, owner-only) match Slack, with an Approve/Deny card and
  `/policy`. When a tenant has several projects and nothing is bound yet, Teams
  asks which project to use and replays the message you already sent.
- **Teams messages read like Teams messages.** The agent's markdown renders as
  card elements — headings, tables, bold, monospace code — instead of raw text.
  Step source citations appear under the answer. `teams send --card-file`
  delivers a complete Adaptive Card as the reply.
- **Replace a project's repository.** Point an existing project at a different
  repository, authorized per repository rather than per account.
- **Every managed Kortix model now accepts images.** The lineup moved to the
  Morph catalog with Kimi K3 and GLM Flash; text-only models are hidden rather
  than offered and then refused.
- **Model pricing and data handling are visible before you pick.** The model
  manager shows each managed model's modalities, its zero-retention status, and
  which connected account pays. Regional options cover US-only and EU
  inference, with the retention terms stated.

## Improved

- Session transcripts stay complete. A session accepts messages while its
  transcript history starts the runtime, so you are not waiting on a sandbox to
  type.
- Attachments are stored before the sandbox starts, so a file sent with the
  first message is still there when the agent reads it. Older sessions recover
  attachments that previous versions could not read back.
- Teams replies post faster: the live card goes up before identity resolution,
  and the webhook acknowledges before dispatch.
- Provider keys keep your draft while saving, and the provider list collapses
  to a count so the managed set stays in view.
- Group and member pages stay current after a directory update, and attaching a
  group to a project now grants its agents.

## Fixed

- A prompt sent before the model catalog finished loading was dropped. It is now
  held and sent.
- The model picker spun forever for every project member, and for a project with
  no id.
- A sent message came back as the project-home draft.
- The session sidebar reordered itself while you were reading it.
- An idle session's Files panel showed a permanent spinner instead of its files.
- The Teams source filter crashed the project page.
- Removing an attachment whose upload was still starting left it behind for a
  day and counted against the attachment limit.
- Sessions resumed after a pause no longer fail on stale provider credentials.
- Repository controls stay visible and readable at the minimum window size, and
  the replacement flow is fully translated.
- Teams session titles, sidebar entries, and channel cards no longer show raw
  `<at>` mention markup.
- A Teams turn that died mid-flight no longer wedges the conversation.
- Bot tokens are sent only to Bot Framework attachment hosts, and a team-drive
  upload is authorized against the conversation it belongs to.

