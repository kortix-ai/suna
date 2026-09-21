Turns say how they ended, a workspace chooser on the way in, and member-owned access tokens

Sessions now say exactly how a turn ended, signing in lands on a workspace
chooser instead of an auto-created project, and every member can mint their own
access token.

## New

- **A turn tells you how it ended.** Every turn carries one typed outcome, so a
  failed turn reports the recorded cause instead of a blank row — and a turn you
  stopped yourself is recorded as stopped, not as a failure. `GET /turn` lists
  failed turns with the reason each one ended.
- **A workspace chooser on the way in.** Signing in shows your workspaces and any
  pending invites rather than silently creating a project for you. With no
  workspaces yet, the chooser is the create form.
- **Every account member can mint and revoke their own personal access token.**
  It no longer takes an owner.
- **Teams asks with a card.** The question tool renders a real card with inputs,
  dropdowns and toggles behind one Submit, and replies in a group chat continue
  the session without a mention.

## Improved

- The model picker collapses every provider group, and the zero-retention and
  US-inference facts sit on one line instead of a banner.
- An image sent to a channel never runs on a model the agent is not allowed to
  use; the pin is checked per message rather than trusted from the catalog.
- Deleting a project from Settings redirects instead of leaving you on a dead
  page.
- Resuming a session keeps the repository workspaces it had before.

## Fixed

- A failed turn with no named cause now says it stopped, rather than showing
  nothing.
- The stale-turn sweep aborts the runtime turn, not just its card.
- An unresolvable agent grant now fails closed for codex models instead of
  quietly picking a model the agent may not use.
- An unowned conversation returns "not found" rather than "forbidden", so it
  cannot be used to probe what exists.
- A form field id containing a comma is rejected.
- An audit entry for the new account-invites route renders with a readable
  label.
- Release publishing no longer depends on the npm registry: a registry failure
  can no longer cost a release its tag, its downloads or its changelog entry,
  and the release refuses to publish with missing downloads.

