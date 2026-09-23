Agents as principals, Teams complete, and saved history without a sandbox

### New
- **Agents act as their own principal.** An agent session now acts as the agent, on behalf of the person who started it, and every audit event records both. The `kortix_cli` permission scope is now `kortix_permissions`.
- **Microsoft Teams is complete.** Agent questions, images, and the remaining Teams flows now work like Slack.
- **Saved history works while the sandbox is off.** Session transcripts and their attachments load on web, SDK, and CLI without waking the sandbox.
- **Mermaid previews.** `.mmd` and `.mermaid` files render as diagrams in the file viewer.
- **Mobile app revamp.** New primitives, a project stack, and session chat parity with web. Session logic is now shared through `@kortix/sdk`.

### Improved
- **Download is a visible primary action** in the file viewers.
- **Session layout:** a centered session column, sub-agent tree lines, neutral queued-message bubbles, tighter connector intake spacing, and a working send from project home.
- **Sandbox memory guard:** a turn stops only on real memory pressure, and every stop says why.

### Fixed
- **Slack:** in a workspace with more than one Kortix Slack app, an app no longer answers replies in another project's thread, so the right bot replies again.
- **BYOK billing:** sessions on your own provider key are never charged Kortix credits, and usage is attributed correctly.
- **CLI:** `kortix sessions rm` retries a stalled delete instead of hanging.
- **Git:** shallow pushes are accepted.
- Usage descriptions are fully localized.
- Internal: the Pi raw event envelope carries its own id; commit hooks block customer data and work in older worktrees; release-gate test fixes.
