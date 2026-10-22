Platinum Inference, session logs for every project, and bring-your-own S3 for Capture

## New

- **Kortix managed models run on Platinum Inference.** The managed model list, prices, limits and reasoning levels come live from Platinum, so a model Platinum adds reaches Kortix without a release. Self-hosted and bring-your-own-key projects can add a Platinum key and call `platinum/<model>` directly.
- **Session logs for every project.** The session log is on by default, so every project stores its conversations in it.
- **Bring your own S3 for Kortix Capture.** An admin can keep an account's recordings in the account's own S3 bucket from Capture → Settings → Storage. Self-hosted Kortix can use an external S3 object store for Capture.
- **Session rows say what waits on you.** The sidebar shows a question or permission, an open change request, and the sub-agents and sessions a session started.
- **Reminders** glide between rows, and 30 or more reminders open in the side panel.
- The turn-done toast offers **Review** for the change request the turn opened.
- Remove a project skill from its card on the Skills page.
- New sandboxes always run on Platinum. Sandbox templates no longer offer Daytona.
- White-label examples: Lumen, a legal AI app on one shared Kortix project with a Team Console, and the Lumen Workspace reskin.

## Improved

- Faster LLM gateway admission: each upstream has its own circuit breaker, admission reads run in parallel, and the default model is resolved only when a request needs it.
- Change requests that an agent opens show at turn end. An applied change request refreshes agents and Needs you.
- Pinned sessions sit above the Sessions header.
- Transcripts show while the sandbox is still starting.
- Compaction stays inside the Worked section.
- The model picker never preselects a model whose provider is not connected, and it says what to connect.
- Marketplace add stays on the page, and search keeps its query in the URL.
- Billing shows Plan member usage and the credit reset and expiry dates.
- Command palette search finds "Your first chat with Kortix".
- The session slash menu lists skills again on pi.
- CLI: 17 commands match the API again, `doctor` picks an available model, and `sessions rm` without `--project` deletes exactly the named session or nothing.

## Fixed

- Security hardening: hosted APIs no longer trust the legacy Supabase signing secret, a token cannot be minted already expired or outlive the token that minted it, the sandbox daemon refuses symlinks that point outside the workspace, billing state needs `billing.read`, account names refuse markup, and deleting an account revokes its credentials.
- Trigger runs close when their turn ends, and queued creates link to their run.
- A skill created with the form shows on version 3 projects.
- A channel's model pin is stored again.
- Capture search reads the requested day, routing policy keeps generation defaults, and credit reads follow the account.
- Editing a v2 agent keeps the keys the update cannot carry.
- A missing attachment answers 404 instead of a retry. Five routes stop reporting permanent failures as temporary. A command that timed out keeps its unknown outcome.
- A session mention in a message you just sent keeps its title.
- Incomplete personal accounts are cleaned up when their user is deleted.
- Many smaller fixes and cleanups across the web app, the CLI and the API.
