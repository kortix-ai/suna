---
recorded: 2026-10-02T08:39:42Z
incident_date: 2026-10-02
---
# Write and read a channel prompt header through one shared module, never two copies of its format

**Rule:** A line the API writes into a channel prompt and the web parses back out has one home: a builder and a reader in `@kortix/shared`, with a round-trip test. The Slack follow-up header is `slackFollowUpHeader` / `readSlackFollowUpHeader` in `packages/shared/src/slack-text.ts`. When you change a channel prompt renderer, change the shared pair, or add one, in the same change. A parser test fixture copied by hand from a renderer does not count: it keeps passing when the renderer moves.

**Trigger surface:** Changing `renderFollowUpPrompt` or `renderAgentPrompt` in `apps/api/src/channels/{slack,teams}/session.ts` or `telegram-webhook.ts`; changing `apps/web/src/features/session/turn/channel-message.ts`; adding a channel.

**Incident:** 2026-09-30 to 2026-10-02, dev, and prod from v0.13.45. #8522 (`188ec459d3`) changed the Slack follow-up header from `New message from <user> in the same Slack thread:` to `New message from <user> in Slack channel <channel>, thread <ts>:`. The web parser kept the old pattern, so every Slack follow-up in a session rendered as the raw prompt (reply instructions and ids) instead of the message card. The web tests passed throughout: their fixtures were copies of the old shape.

**Enforcement:** `packages/shared/src/slack-text.test.ts` round-trips the header (labelled, bare, and a display name that holds the separators). The API renderer and the web parser both import the pair, so the format cannot drift between them. Not yet shared: the first-message scaffold fields (`Channel:`, `User:`) and the Teams and Telegram headers. Move each into `@kortix/shared` the next time it changes.
