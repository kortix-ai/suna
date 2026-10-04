Fork a conversation, cancel from billing, and one permission per topic

## New

- **Fork a conversation.** A session's conversation offers a Fork action, so you can branch from any point.
- **Cancel a subscription from the billing pane.**
- **One permission per topic.** The broad `project.customize.*` permissions are replaced by `project.settings.write`, `project.sandbox.write`, and `project.model.read`/`.write`. Agent changes use `project.agent.write`. Every role keeps exactly what it had. Project members can now open Agents and Triggers read-only.

## Improved

- **Sign-in:** an existing account opens on the password form, and the email link is one click away. After you enroll in two-factor authentication, sign-in asks for the code. A magic link still completes when its verifier cookie is lost. A failed server sign-out is reported on the sign-in page.
- **Security settings** list the devices that are signed in.
- **Account deletion:** "Delete immediately" deletes the account, and the dialog reads as a choice.
- **Creating a project** lands you on the project page.
- **The session key panel** says whose keys a session reaches, and why a key is not available.
- **Connectors:** Computers appear under Connected only after a machine is paired, and connector notes display the same way on every surface.
- **The audit log:** reconciliation catches up on accounts with very large histories.
- **The API** returns 400 for a malformed account id, and a marketplace install fails clearly when no model can serve its import.
- **Database health:** more RLS policies evaluate the signed-in user once per query, and legacy tables gain primary keys and missing indexes.

## Fixed

- The CLI:
  - `sessions log` and `chat` show the real stop or failure reason.
  - Trigger schedule updates keep their time zone.
  - Policy conditions keep their operators.
  - `--json` output and session listings stay stable.
  - `projects rm --purge` reports "Purged".
  - Project-scoped commands reach projects that have no session.
  - The empty models state points to providers.
- Mobile:
  - Question answers can be retried until they are accepted.
  - Mermaid diagrams render.
  - Teams mentions are stripped from session titles.
  - Diff stats keep literal escapes.
  - App previews refresh their credentials when opened.
- Desktop: "Allow all" adds Kortix to the macOS Screen Recording list.
- A warm session that has not been prompted reads as starting, not running.
- The sandbox agent's dependencies are patched against two `undici` vulnerabilities.
- Customize tabs appear immediately, and only the page body waits for permissions.

