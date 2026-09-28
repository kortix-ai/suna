---
recorded: 2026-09-28T11:57:57Z
incident_date: 2026-09-28
---
# Show an identity-linking link only where the person it names alone can see it

**Rule:** A link that binds a chat identity to whoever opens it is shown only where the person it names alone can see it: a one-to-one chat, an ephemeral message, a DM. In a channel or group chat, post a card with no link that sends the person to a private chat. Check every place that renders the link, including `/login`, `/whoami` and the unlinked-message prompt.

**Trigger surface:** identity linking in any chat channel: `teams/login-card.ts`, `teams/identity.ts`, `teams/commands.ts`, `slack/identity.ts`; any signed login or bind URL.

**Incident:** found in a code audit on 2026-09-28, live in prod. The Teams Connect card with the sign-in link was posted in every conversation, and `/bind` links the Teams user named in the token to the Kortix user who opens it within 10 minutes. In a channel or group chat anyone could have linked another person's Teams identity to their own Kortix account, so that person's messages would run as them. Slack already used an ephemeral message plus a DM. Not known to be exploited. PR #7963.

**Enforcement:** `unit-teams-login-card.test.ts` (the link only in a one-to-one chat; none in a channel, group chat or conversation of unknown type).
