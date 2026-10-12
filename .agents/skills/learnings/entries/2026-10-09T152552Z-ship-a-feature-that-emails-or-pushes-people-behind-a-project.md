---
recorded: 2026-10-09T15:25:52Z
incident_date: 2026-10-09
---
# Ship a feature that emails or pushes people behind a project flag that is off by default

**Rule:** A change that starts sending email, Web Push or phone pushes to new recipients ships behind a per-project feature flag with `platformDefault: () => false`. With the flag off, the project keeps the old delivery exactly. Merging to `dev` reaches every person with a dev account, so the dev deploy is not a safe test bed for outbound messages.

**Trigger surface:** Adding a recipient rule, a channel (email, Web Push, Expo) or a digest. Also: removing a gate in front of an existing sender.

**Incident:** PR #9446 (KRTX-1742, 2026-10-09) merged the notification inbox, Web Push and the email digest ungated. After the dev deploy, every dev project mailed immediate automation alerts and 15-minute digests to its members. PR #9459 put the whole feature behind `notification_center` (off by default) and restored the pre-merge creator-only phone push for flag-off projects. The digest also drops rows of flag-off projects, so rows written before the fix were never mailed.

**Enforcement:** `tests/src/flows/notifications.flow.ts` › NOTIF-9 (a flag-off project writes no inbox row, alert edge or watcher row, its watch routes answer `403 feature_disabled`, and its stored rows are neither listed nor counted), `apps/api/src/notifications/inbox-read.integration.test.ts` and `digest.integration.test.ts` (flag-off rows are not listed or mailed), and `session-push-legacy.test.ts` (the flag-off push). No generic gate yet. The enforcer to build is a check that a new sender call site is reached only through a flag read.
