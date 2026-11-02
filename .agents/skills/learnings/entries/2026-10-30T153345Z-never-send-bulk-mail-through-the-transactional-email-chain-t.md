---
recorded: 2026-10-30T15:33:45Z
incident_date: 2026-10-29
---
# Never send bulk mail through the transactional email chain that carries sign-in mail

**Rule:** A job that emails a large share of all users (a legal notice, an
announcement) never calls `sendEmail` / `sendAlertEmail`. That chain (SES, then
Resend) carries sign-in mail and shares one SES 24-hour quota with it. A sweep
that sends stops at the first failed send instead of retrying the whole batch.

**Trigger surface:** Any worker or script that loops over `auth.users` or all
accounts and sends mail; any `BATCH` constant in front of `sendEmail`.

**Incident:** 2026-10-29 15:10 to 2026-10-30 13:31 UTC, production. The
hourly `legal-terms-notices` worker (#11004) emailed a Terms change to every
signed-up user, 10,000 per sweep. It used up the SES 24-hour quota (`429 Daily
message quota exceeded`) and the Resend monthly quota (`429
monthly_quota_exceeded`) by 19:00. A failed send released the user's claim, so
every later sweep retried 10,000 users: 234,158 failed attempts in 22 h. On
2026-10-30 magic-link sign-in on kortix.com failed with "Error sending magic
link email". Prod GoTrue does not call the API send-email hook (0 signed calls
in 60 days); it sends over the SMTP relay set in the Supabase dashboard. That
relay most likely draws on the same SES quota. Not verified: the Supabase auth
config was not readable from the repo's tokens. The sweep paused only because the v0.14.11 deploy restarted the leader
timer. The sweep was removed, and no notice is sent.

**Enforcement:** None automated. The sweep and its test are deleted, and the
`compliance` skill states that Kortix does not email Terms changes.
