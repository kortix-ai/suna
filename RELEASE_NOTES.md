Sessions keep their own agent, and explicit repository access

### Fixed

- **Sessions keep their own agent.** A session could be switched to an agent from a different project after a prompt that named no agent, which removed its access to connectors and the Kortix CLI. Every session now always runs as its own agent, and a session that was affected recovers on its next message.
- **The first message on the home screen no longer gets stuck** in the composer after a slow start.
- **Project pages load cleanly.** The project home shows the Kortix mark while it loads instead of a flashing placeholder.
- **Session history is saved before a session stops**, and responses from the in-sandbox model proxy are no longer returned in a corrupted encoding.
- **Admin project list** shows each project's own session counts.
- **Customize settings show what you saved.** After saving an agent or connector setting, a reload could show the previous value for up to a minute.

### Improved

- **Repository access is explicit.** Agents now declare whether a session gets the project's files, replacing the older workspace modes. Older API clients keep reading restricted manifests correctly.
- **Previews route correctly** and set up shared sandboxes in isolation.
- **Release checks are more reliable**: preview environments use their own database, confirm the running runtime, and wait for completed agent artifacts before asserting on them.
