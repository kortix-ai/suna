---
recorded: 2026-10-01T11:37:14Z
incident_date: 2026-10-01
---
# In a Teams channel or group chat, say what is for one person in a targeted message, and never let a secret fall back to a public card

**Rule:** In a Teams channel or group chat, send what is for one person as a targeted message: `sendTargetedCard` or `replyPrivately` (`teams/private-reply.ts`). This covers prompts, refusals, command replies and approval cards. Post the public live card only after the sender may run. A targeted message that Teams refuses falls back to the whole conversation. So a card that only that person may see, such as the sign-in link, never goes through `sendCardPrivately`. `login-card.ts` sends it targeted, then to the 1:1 chat, and never to the conversation. Teams has had targeted messages since 2026-07-30 (GA): Slack's ephemeral, marked "Only you can see this message". This refines the 2026-09-28 identity-link entry, which called for a link-free card in shared conversations.

**Trigger surface:** any Teams code that posts in a conversation in answer to one person: `teams/session.ts` (live card ordering, refusals), `teams/identity.ts`, `teams/login-card.ts`, `teams/commands.ts`, `teams/participants.ts`. Also any new Teams notice, and porting a Slack `postEphemeral` to Teams.

**Incident:** 2026-10-01, found in a two-user test on dev. No secret was exposed: the card had no link. An unlinked member mentioned the bot in a channel thread. The public "Working on it…" card turned into "Connect your Kortix account" for every member of the team. Other public messages that Slack shows only to one person:
- command replies, including `/sessions` with the user's session titles;
- join-policy refusals;
- the owner's Approve / Deny card;
- the approval decision.

PR #8609.

**Enforcement:**
- `unit-teams-login-card.test.ts` ("no card the whole conversation sees ever carries the link", across all three outcomes);
- `unit-teams-session.test.ts` (in a channel or group chat the live card waits for identity, the join gate and the agent scope; refusals go to the sender alone);
- `unit-teams-api-direct.test.ts` (the `?isTargetedActivity=true` + `recipient` contract).
