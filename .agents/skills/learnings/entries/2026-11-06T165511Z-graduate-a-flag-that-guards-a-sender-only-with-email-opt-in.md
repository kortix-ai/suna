---
recorded: 2026-11-06T16:55:11Z
incident_date: 2026-10-09
---
# Graduate a flag that guards a sender only with email opt-in for every recipient the flag kept out

**Rule:** When a flag that guards email, Web Push or phone pushes graduates, every email the flag kept from going out becomes opt-in per person, and every email that already went out with the flag off keeps its default. Graduating a sender is the same change as adding one: the deploy reaches every person on the environment at once.

**Trigger surface:** Removing or defaulting on a feature flag in front of `deliver`, a digest or any other sender; changing a kind's default in `DEFAULT_NOTIFICATION_PREFERENCES`.

**Incident:** The 2026-10-09 rule (ship a sender behind a flag that is off by default) came from #9446, which mailed every dev project's members after one deploy. On 2026-11-06 the `notification_center` flag graduated. With its old defaults that would have repeated #9446 on dev and then prod: email on for errors, questions, shares and failing automations. The graduation set those kinds to email off. The alerts that already emailed with the flag off (an App health streak, an auto-pause, a capture computer that went down, an artifact comment) kept email on. A failure-streak alert lowers its own default with `DeliverInput.emailDefault: false`.

**Enforcement:** `packages/shared/src/notification-kinds.test.ts` › "email is opt-in for the kinds only the notification center ever mailed"; `apps/api/src/notifications/notifier.integration.test.ts` › "a delivery that lowers its email default mails only the people who opted in"; `apps/api/src/__tests__/integration-trigger-alerts.test.ts` › "alerts that emailed before email became opt-in still do". NOTIF-9 in `tests/src/flows/notifications.flow.ts` now tests the graduated contract, not the flag-off one.
