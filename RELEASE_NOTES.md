Computers work like every connector, and the audit trail records the credential that made each call.

Computers work like every connector, and the audit trail records the credential that made each call.

## New

- Computers are connector accounts like any other: the same row, the same Share dialog (people, groups or everyone), and one registration per machine.
- The audit trail shows **Via** for each event: the credential the API authenticated (browser session, personal access token, connected app, session token, API key, service account or SCIM token), never a self-reported client label.

## Fixed

- Slack and Teams connector reads stay inside the calling project's own conversations.
- Stopping a session no longer fails with a database deadlock when a wake runs at the same moment.
- A malformed member id returns 400 instead of 500.
- A stopped session box stays stopped: auto-resume is turned off before the stop, not after.
- A transient git failure while saving a project's manifest returns a retryable 503 and no longer exposes the repository URL.

