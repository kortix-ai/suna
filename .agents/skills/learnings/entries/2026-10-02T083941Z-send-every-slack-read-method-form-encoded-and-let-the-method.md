---
recorded: 2026-10-02T08:39:41Z
incident_date: 2026-10-02
---
# Send every Slack read method form-encoded, and let the method name decide, never the call site

**Rule:** Slack's read methods (`*.info`, `*.list`, `*.history`, `*.replies`) drop a JSON body and answer as if no argument was sent. `slackApiCall` form-encodes every such method through `slackSendsForm(method)`. Never add a second Slack HTTP helper that skips it, and never treat `channel_not_found` or `user_not_found` from a read as proof that the entity is gone before you check the request encoding.

**Trigger surface:** Adding or changing a Slack Web API call in `apps/api/src/channels/slack-api.ts`; adding a Slack HTTP client anywhere else; debugging a Slack lookup that answers `channel_not_found` or `user_not_found` for an id Slack itself returned.

**Incident:** 2026-05-23 to 2026-10-02, dev and prod. `getChannelName` sent `conversations.info` as JSON from its first commit (`fff71fd360`). Every lookup answered `channel_not_found`, so no Slack binding was ever named: the Channels page and `kortix channels bindings` showed `C0…`/`D0…` ids for every Slack channel. The same failure hit `users.info` on 2026-08-19 and was fixed at that one call site (`form: true`), which left the next read call free to repeat it. The error reads as bad data, not a bad request, so it survived review and live use twice.

**Enforcement:** `apps/api/src/__tests__/unit-slack-conversation-label.test.ts`: `slackSendsForm` returns form for every read method even when the caller passes `form: false`, and `describeSlackConversation` sends `application/x-www-form-urlencoded` with the channel id in the body. `unit-slack-bot-mentions.test.ts` pins the `users.*` call sites.
