---
recorded: 2026-09-22T07:49:06Z
incident_date: 2026-09-22
commit: 12c8e0a26b
---
# Port a guard with the feature, or the second platform ships without it

**Rule:** When a channel/platform copies an interaction from another, copy its
AUTHORIZATION, not only its rendering. A card posted to a conversation is
visible to everyone in it, so the check belongs on the PRESS, and it is scoped
to the account of the object being acted on — not to whatever account the
presser happens to belong to. **Trigger surface:** adding an
`Action.Execute` / Block Kit button that mutates anything, or porting a handler
between `channels/slack/` and `channels/teams/`.

**Incident:** `handleReview` in `channels/teams/interactivity.ts` checked only
that the presser had *some* linked Kortix identity in the tenant
(`lookupTeamsIdentity`). It never checked project access. Any Teams user in the
tenant who had ever run `/login` could **Approve or Deny a review item for a
project they are not a member of** — the human gate in front of whatever the
agent flagged as risky. Slack's twin has always called `resolveSlackActor`, and
carries the comment "The actor must be a linked Kortix user with write access
to this project". Teams had `resolveTeamsActor`, with an identical signature
and the full member + `PROJECT_WRITE` check, sitting unused. Found by auditing
handlers while writing user docs, not by an alert. Exposure was limited by the
`teams` project feature flag; the code was live on `main`.

**Enforcers:** `apps/api/src/__tests__/unit-teams-review-authz.test.ts`, which
was run against the pre-fix file first and failed 3 of 4 — a security test that
passes before the fix proves nothing.
