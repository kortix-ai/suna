Admins can open every session, a project home that sends, and history that fills in on wake

Owners can let admins open every session in their account, sending a message
from the project home no longer freezes the box, and a woken session fills in
its saved history.

## New

- **Let owners and admins open every session.** An owner can turn on an account
  policy that gives owners and admins access to every session in the account.
  It is off by default, only an owner can change it, and every session opened
  this way is recorded in the audit log.
- **See who owns each session.** The Sessions page shows each session's owner and
  filters by owner and by access.

## Improved

- Sending from the project home sends the message instead of freezing the input,
  and the composer stays in one place through the send.
- A session that wakes fills in its saved history.
- The waiting indicator stops while a turn is waiting on you.
- When a session cannot start, the reason is shown instead of a generic error.

## Fixed

- Creating a project during a GitHub rate limit now tells you to retry and when,
  instead of failing.
- Rebuilding a sandbox image that is still in use explains why it cannot proceed.
- Restarting or starting a session no longer erases what another in-flight
  request recorded about it.
- Session-access audit entries are translated.

