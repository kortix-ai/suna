---
recorded: 2026-11-03T18:18:41Z
incident_date: 2026-11-03
supersedes: 2026-10-20T071256Z-after-a-capture-version-self-host-update-reload-caddy-so-the.md
---
# Let kortix self-host update reload Caddy whenever it rewrites the Caddyfile, so a new route is served

**Rule:** A self-host change that adds or edits a Caddy route ships with its reload.
`kortix self-host update` compares the Caddyfile before and after it re-renders the
assets, and in domain mode runs `caddy reload` when they differ. Never rely on
`docker compose up` for this: Compose does not recreate a container for a changed
bind-mounted file, so the old routes stay live and the new prefix answers the
API's JSON `404`. Prove a route on a box with
`curl -s https://api.<domain>/<prefix>/`: a MinIO prefix answers S3 XML
(`AccessDenied`), never `{"error":true,"status":404}`.

**Trigger surface:** `apps/cli/src/self-host/assets/Caddyfile.txt`,
`renderCaddyfile()` in `compose-assets.ts`, `selfHostUpdate()` in
`apps/cli/src/commands/self-host.ts`; upgrading a domain-mode self-host box.

**Incident:** Near-miss, 2026-11-03. The project snapshot bucket on the self-host
MinIO adds an `@snapshots` route. A customer domain-mode box answered the API's
JSON `404` on `/kortix-capture/` from outside: the 2026-10-20 symptom of a Caddy
that never reloaded. Without the reload, every new sandbox there would have
failed its snapshot download and fallen back to Git, so the change would have
shipped with no speed-up and no error. Changes from the 2026-10-20 entry: the
manual `caddy reload` is now automatic on `update`, and the rule has an enforcer.

**Enforcement:** `apps/cli/src/self-host/__tests__/self-host-cli.test.ts`
"update reloads Caddy when the new version changes the Caddyfile, and only then"
renders an instance from before the `@snapshots` route, runs `update` against a
stubbed Docker, and asserts one `caddy reload`, then no reload on a second
`update`. Still to build: `kortix self-host doctor` probes each MinIO prefix for
an S3 answer instead of only checking that the container exists.
