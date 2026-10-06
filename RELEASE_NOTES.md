See the model behind each answer, pi 1.0, and config releases that follow your repository

## New

- **See the model behind each answer.** A session shows which model answered and what the answer cost.
- **pi 1.0.** The pi harness is on pi 1.0. It brings compaction and slash commands, and pi now runs only inside the sandbox.
- **Config releases follow your repository.** A release is a checkout of the base branch with the repository's own layout. An unbuildable or quarantined tip no longer drops a session's configuration without notice.
- **Security settings:** a redesigned authenticator-app enrollment, and a list of every signed-in device. Signing a device out stops its access at once.
- **Viewers:** the session file and App viewers show an address bar. App previews show calmer loading and build states, and hover cards name running ports and links as well as files.
- **Mobile:** an updated app, with JavaScript changes now delivered as over-the-air updates. It adds channel cards for Slack and Teams prompts and one progress indicator per running turn. The Files row opens the Files page, and the project's Apps are listed.
- **Downloads:** the desktop installer has a drag-to-install window, and /download links to the App Store and Google Play listings.
- **The website** describes Kortix as the open-source AI Operating System.

## Improved

- When a ChatGPT usage limit is reached, the gateway falls back to the project's model chain and says when the limit resets.
- A failed sandbox template build names its cause.
- Adding a member by email is faster.
- Sandbox shells no longer write core dumps.

## Fixed

- Editing a sent prompt keeps its attachments, and so does editing a prompt queued while the session boots.
- A manual trigger run no longer fails when it races a new session that creates the same agent identity.
- Relative OpenCode instructions read from the release, not from the workspace.
- The demo booking confirmation stays open until you close it.
- The Kortix web app is patched against three new vulnerabilities in its dependencies.

