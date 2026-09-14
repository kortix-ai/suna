# API router Worker and the managed-git credential

Two things that broke silently together on 2026-08-30 → 2026-09-07 and how to
check each in under a minute.

## The Worker in front of `api.kortix.com` / `gateway.kortix.com`

`infra/cloudflare/workers/api-router/worker.mjs` is the Cloudflare Worker that
fronts the API and the LLM gateway in every environment. It picks the active
backend, applies the admin maintenance state, and passes origin responses
through unchanged (since #6831, 2026-08-24). Before #6831 it rewrote every
origin 502/503/504 into a synthetic
`503 {"message":"Kortix is temporarily unavailable. Service will resume automatically."}`.

**Who deploys it**

| env | job | trigger |
|---|---|---|
| prod (`api-kortix-router`) | `deploy-api-router` in `.github/workflows/deploy-prod.yml` | every prod release, after `deploy-ecs` |
| staging (`staging-api-kortix-router`) | `wire-cloudflare` in `deploy-staging.yml` | every staging deploy |
| dev (`dev-api-kortix-router`) | by hand | — |

Until 2026-09-07 nothing deployed the prod Worker. It ran a 2026-08-21 build for
17 days, and 8 days of failed project creation reached Better Stack as a
maintenance page nobody had switched on.

**Check what is live**

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/9785405a992435bb0c7bd19f9b6d26d5/workers/scripts" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq -r '.result[] | select(.id|test("api-kortix-router")) | "\(.id) \(.modified_on)"'
```

Compare `modified_on` with the last commit to `worker.mjs`
(`git log -1 --format=%ci -- infra/cloudflare/workers/api-router/worker.mjs`).
If the live script is older than that commit, it is stale.

**Deploy by hand** (the scoped `CLOUDFLARE_API_TOKEN` from `apps/api/.env` works;
`wrangler.toml` `[env.<env>.vars]` is the single source of bindings):

```bash
cd infra/cloudflare/workers/api-router
CLOUDFLARE_API_TOKEN=… npx --yes wrangler@4 deploy --env prod   # or staging / dev
```

**Prove the passthrough.** Send a request the origin will refuse and read the
body. A real origin error body means the Worker is current; the maintenance
message above means it is stale (or an admin really set `level: blocking` —
check `GET https://api.kortix.com/v1/system/maintenance`).

## The managed-git credential

Managed projects live as repos in the GitHub org `managed-kortix`. The API
creates them with, in this order (`apps/api/src/projects/git-backends/github.ts`):

1. a PAT stored through `POST /v1/platform/github-app/pat`
   (`platform_settings.managed_github_app.pat`, 30 s cache per task);
2. `MANAGED_GIT_GITHUB_TOKEN` from the environment;
3. an installation token of the GitHub App (`KORTIX_GITHUB_APP_*` +
   `MANAGED_GIT_GITHUB_INSTALL_ID`).

A PAT short-circuits the App everywhere. `GET /v1/platform/github-app/status`
reports which one is in use (`source: pat | db | env`).

**A credential is verified by the write it authorises, never by a read.**
Creating an org repo needs `Administration: write` (fine-grained PAT, resource
owner = the org) or the `repo` + `delete_repo` scopes (classic PAT), or an App
installation with `administration: write`. `GET /orgs/managed-kortix/repos`
returning 200 proves nothing about that. `POST /v1/platform/github-app/pat`
performs a create+delete probe (`verifyRepoAdminToken`) before storing anything.
To check a token by hand:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.github.com/orgs/managed-kortix/repos \
  -H "Authorization: Bearer $TOKEN" -d '{"name":"kortix-credential-probe-manual","private":true}'
# 201 → then DELETE /repos/managed-kortix/kortix-credential-probe-manual (expect 204)
# 403 "Resource not accessible by personal access token" → the token cannot create repos
```

**Prove provisioning end to end** against the real environment:

```bash
curl -s -N -X POST https://api.kortix.com/v1/projects/provision-stream \
  -H "Authorization: Bearer $KORTIX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"probe-provision"}'
# expect frames validating → creating_repository → registering → seeding → done
# then DELETE /v1/projects/<project_id>; the managed repo is NOT deleted with the
# project (known gap) — delete managed-kortix/<slug>-<project_id> by hand.
```

Incident record: memory `prod-provision-dead-fine-grained-pat-2026-08-30`;
learning "Verify a rotated credential with the WRITE it exists for" in
`.claude/skills/learnings/SKILL.md`.
