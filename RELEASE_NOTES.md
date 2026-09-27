Share connector accounts, mobile push notifications, and pi.dev packages

Share connector accounts with groups and people, mobile push notifications, and pi.dev packages for pi sessions.

## New

- **Share connector accounts** with specific groups, specific people, or everyone in the project. Anything can also be granted to everyone in a project.
- **Mobile push notifications** when a turn completes, fails, asks a question, or needs a permission, even while the app is closed. Transcripts can also be shared as a public link from mobile.
- **pi.dev packages.** pi sessions can load any extension from pi.dev, per project, per agent, or for every session.
- **Claude Code on the gateway.** Claude Code works fully against `/v1/messages`, and ChatGPT models work from a gateway key.

## Fixed

- A long run whose first prompt has not loaded yet still reads in order.
- A sandbox's binaries update at a turn boundary instead of waiting for a restart.
- A restart failure is no longer reported as a lost computer before the provider is asked, and a removed parked box is recovered first.
- A parked session stays stopped under passive traffic, and the app stops polling a parked or unreachable sandbox.
- Unconfigured sessions use the project's shared ChatGPT accounts.
- Bring-your-own Anthropic-compatible providers respect their configured base URL.
- A session name set at creation is kept.
- The session audit view loads without 25-second timeouts.
- Interleaved text in streamed Anthropic responses opens its own content block.
- An invalid Composio toolkit returns a clear error instead of a server error.
- Tool output is parsed in linear time on web, mobile and the SDK.
- Several browser errors no longer surface as app errors.
- Project routes always run authentication before the route handler.
- Mobile Review merges work and feel instant, with change-request cards in sessions.
- Historical session dates and activity ordering are restored for migrated sessions.
- The web app no longer hits React error #467 while loading translations.

