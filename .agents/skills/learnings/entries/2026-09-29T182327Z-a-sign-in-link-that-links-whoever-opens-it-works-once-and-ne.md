---
recorded: 2026-09-29T18:23:27Z
incident_date: 2026-09-29
---
# A sign-in link that links whoever opens it works once and never replaces a live link

**Rule:** A signed link that binds an identity to whoever opens it must be
spent on first use (a nonce claim), and the bind must never replace a live link
to a different account. Put that check in the write itself (one SQL
statement), not in a read before the write.

**Trigger surface:** Slack and Teams `/login` links (`/channels/*/identity/bind`),
and any new "click to connect" link that carries a signed identity claim.

**Incident:** 2026-09-29, the same Teams permissions audit (near-miss). A login
link stayed valid for 10 minutes and `linkChatIdentity` upserted over any live
link, so anyone who obtained a person's link (forwarded, screenshotted, from a
shared screen) could re-point that chat identity at their own Kortix account
and receive that person's later messages as sessions in their own account. Fixed on branch `ino/teams-permissions`:
the nonce is claimed in `chat_event_dedup`, and the upsert's `setWhere` refuses
a live link to another user (409 at `/bind`).

**Enforcement:** `apps/api/src/__tests__/integration-chat-identity.test.ts`
(real PostgreSQL): a live link never moves to another user, a sign-in link
works once, and a new link cannot take over a live one.
