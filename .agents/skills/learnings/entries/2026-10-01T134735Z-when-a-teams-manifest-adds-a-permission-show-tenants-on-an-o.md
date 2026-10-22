---
recorded: 2026-10-01T13:47:35Z
incident_date: 2026-10-01
---
# When a Teams manifest adds a permission, show tenants on an older catalog version and name who updates it; the change never reaches an installed team by itself

**Rule:** A Teams manifest change reaches a team only after two people act.
First, a Teams admin publishes the new package to the org catalog
(`teams/catalog.ts` needs their delegated sign-in, so Kortix cannot push it).
Second, for a new permission or message action, a team owner accepts the
update in each team (Teams installs other updates on its own). Bump
`TEAMS_MANIFEST_VERSION` on every manifest change, text included: Graph
refuses an app-definition update that does not raise the version. The
Channels page and `kortix channels status` compare it with the version the
catalog serves (`MS_TEAMS_APP_VERSION`, read at each publish) and offer the
update. A Graph refusal that names a missing grant must reach the user as who
fixes it, not as Graph's text alone.

**Trigger surface:** Editing `apps/api/src/channels/teams-manifest.ts` (its
RSC permissions, commands, message actions, or descriptions); debugging a
Teams read that answers `403` "Resource specific consent grants on the
request ''".

**Incident:** 2026-10-01, dev. In a Teams channel the agent could not read the
thread it was mentioned in. The test tenant's catalog was published at
2026-09-18 10:09Z, 91 minutes before manifest 1.1.0 added
`ChannelMessage.Read.Group`, so the team still ran 1.0.0 with no read
permission. Nothing showed it for 13 days. The page offered only a generic
"Publish to your Teams catalog" button, and the agent relayed Graph's text,
which names no next step. The same day, #8567 changed the manifest's
descriptions and accent color under 1.6.0 without a bump, so no tenant with
1.6.0 could receive them. The fix records the served version at each publish,
shows "Update the Kortix app in Teams" with both steps, rewrites the refusal
so it names the team owner and the admin, and ships 1.6.1.

**Enforcement:** `apps/api/src/__tests__/unit-teams-manifest.test.ts` ("a
manifest change ships under a new version") pins a fingerprint of the
manifest per version and fails on any unbumped change.
`unit-teams-catalog-publish.test.ts` (the publish reports the version the
catalog serves, also after a refused update), `unit-teams-oauth.test.ts`
(the version is stored), `unit-teams-install-publish-state.test.ts` (when the
update is offered), `unit-connector-channels.test.ts` (the refusal names the
fix), `apps/cli/src/__tests__/channels.test.ts` (status prints both versions),
and `apps/web/.../channels-view.test.ts` (the notice renders from
`appUpdateAvailable`).
