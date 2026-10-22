---
recorded: 2026-10-13T12:44:24Z
incident_date: 2026-10-13
---
# Prove a documented access rule as a non-admin reader before a customer does

**Rule:** When docs promise who gets access (a token, a page, a binding), prove it with a flow that signs in a project member who is NOT an admin and NOT the creator. An owner-only flow passes every access check and proves nothing about readers. When code and docs disagree, fix one of them in the same PR; never let a check exist that the docs deny.

**Trigger surface:** Changing an App access check (`apps/public-proxy-access.ts`, `apps/access.ts`, `apps/bindings.ts`), the token route `/_kortix/token`, or the `kortix-apps` skill references `sign-in.md` and `bindings.md`.

**Incident:** 2026-10-13, a self-hosted enterprise instance on v0.13.56. The `kortix-apps` skill said every person an App admits gets a token for every App it uses. `/_kortix/token` also required the reader to open the used App directly, and answered `403 app_not_linked` (wrong: the App did use it). Readers of an App backed by a private backend App got no backend token, so the App refused them. The only workaround was to admit every reader group to the backend, which listed an infrastructure App on every reader's Apps page. APP-10 used only the owner, who passes every check, so no test saw it.

**Enforcement:** `APP-12` in `tests/src/flows/apps-tokens.flow.ts`: a member admitted only to App A gets a token for private App C that A uses (`via_app_id` = A), cannot list or open C, and A answers 401 without a sign-in. On the old route it fails with `403 app_not_linked`.
