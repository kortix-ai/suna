Kortix in Microsoft Teams and in your terminal, split manifests, and correct compute metering

Kortix now runs in Microsoft Teams and in your terminal, a `kortix.yaml` can be
split across files, every managed model accepts images, and sandbox compute is
metered correctly on free and trial accounts.

## New

- **Kortix in the terminal (experimental).** `kortix tui` opens a full terminal
  client: sidebar with accounts, projects and grouped sessions; session
  transcript with tool cards and interactive prompts; a composer with a command
  palette and model, effort and agent pickers; Files, Review, Apps and Customize
  screens; an embedded terminal; and `opencode` attach mode. It installs its own
  binary on first run, so the CLI stays small.
- **Microsoft Teams.** Run an agent from a channel, a group chat, or a direct
  message. Thread replies continue the same session without a new mention.
  Files work both ways: inline images reach the agent, and results upload to the
  team drive with a link back. Join policies (open, owner-approval, owner-only)
  match Slack, with an Approve/Deny card and `/policy`. When a tenant has several
  projects and nothing is bound yet, Teams asks which project to use and replays
  the message you already sent. The agent's markdown renders as card elements —
  headings, tables, bold, monospace code — with step source citations.
- **Split a `kortix.yaml` across files.** An `imports:` list pulls agents,
  connectors and triggers in from other files, and every connector and agent
  records which file declared it. The CLI, the manifest reference and the
  scheduling docs all understand it.
- **Replace a project's repository.** Point an existing project at a different
  repository, authorized per repository rather than per account.
- **Every managed Kortix model now accepts images.** The lineup moved to the
  Morph catalog with Kimi K3 and GLM Flash, plus text-only DeepSeek V4 Pro.
  Text-only models are hidden rather than offered and then refused.
- **Model pricing and data handling are visible before you pick.** The model
  manager shows each managed model's modalities, its zero-retention status, and
  which connected account pays. Regional options cover US-only and EU inference,
  with the retention terms stated.

## Improved

- Session transcripts stay complete. A session accepts messages while its
  transcript history starts the runtime, so you are not waiting on a sandbox to
  type.
- Attachments are stored before the sandbox starts, so a file sent with the
  first message is still there when the agent reads it. Older sessions recover
  attachments that previous versions could not read back.
- Teams replies post faster: the live card goes up before identity resolution,
  and the webhook acknowledges before dispatch.
- Provider keys keep your draft while saving, and the provider list collapses to
  a count so the managed set stays in view.
- Group and member pages stay current after a directory update, and attaching a
  group to a project now grants its agents.
- Deployments report why a rollout failed instead of only that it timed out, and
  a container starts faster.

## Fixed

- **Sandbox compute is metered on free and trial accounts.** It was not, so
  usage on those accounts went unbilled.
- **Starting a session, sending a prompt and waking an App no longer debit a
  cent each.** Those actions placed a charge they should never have placed.
- **Adding a tool authorizes the project's account, not the clicker's.** The
  connection was being created as a private one owned by whoever clicked, so
  nobody else — and no scheduled run — could use it, while the UI reported it
  connected.
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
- Teams session titles, sidebar entries and channel cards no longer show raw
  `<at>` mention markup.
- A Teams turn that died mid-flight no longer wedges the conversation.
- Bot tokens are sent only to Bot Framework attachment hosts, and a team-drive
  upload is authorized against the conversation it belongs to.
- An out-of-range attachment part now reports "not found" instead of "not
  active", so a caller can tell a permanent error from a temporary one.
- An emptied imported collection stays an empty list rather than becoming an
  empty object.
- `projects upgrade` in the CLI now prompts with the same wording as the
  dashboard.

