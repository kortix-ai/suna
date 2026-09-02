# Preview environments

A pull request with the `preview` label gets a **complete Kortix**, running on
its own: PostgreSQL, Supabase, the API, the LLM gateway, the frontend, and
Mailpit. It stays up until you take the label off or the pull request closes.

## Getting one

Add the `preview` label. That is the whole procedure.

You need write access, and the pull request must come from this repository — a
fork cannot get one, because the deploy runs with real secrets.

## Where the URL is

The workflow posts a **sticky comment on the pull request** with the origin, the
test report, the sandbox id, and the commit. It rewrites that same comment on
every deploy, so it is never stale. The URL is also on the pull request's
**Deployments** panel, as environment `preview/pr-<number>`.

## What lives where

One origin serves everything; the edge splits by path.

| path | serves |
| --- | --- |
| `/` | the frontend |
| `/v1`, `/health`, `/metrics`, `/scim/v2`, `/internal` | the API |
| `/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1` | Supabase |
| `/_gateway/` | the LLM gateway |
| `/_mailpit/` | every email the environment sends |
| `/_tests/` | the `--target-full` report for this commit |

There is no separate API hostname. Anything the API serves outside `/v1` has to
be listed in the edge matcher — see `buildPreviewCaddyfile`.

## Its lifecycle

| event | what happens |
| --- | --- |
| label added | deploys, then runs `pnpm test -- --target-full` |
| you push | redeploys **in place** — same URL, no suite |
| label removed | deleted |
| pull request closed | deleted |
| branch deleted | closes the pull request, so: deleted |

The sandbox is named after the **branch** and reused, which is what holds the
URL still across pushes. Being persistent, it carries no provider expiry — the
pull request leaving the active set is the only thing that retires it, and the
nightly sweep is the second net behind that.

## A stable hostname, optionally

By default the URL is the provider's own
(`https://8080-<sandbox>.<region>.sbx.platinum.dev`). It is stable for the life
of the branch, but it is not memorable.

A branch can instead be fronted by a name you choose. Add an entry to the
repository variable `PREVIEW_PUBLIC_ORIGINS`, one per line:

```
<branch>=https://<host>[=<worker>]
```

`<worker>` is a directory under `infra/cloudflare/workers/` whose Worker serves
that hostname. When it is present, every deploy re-points that Worker at the
sandbox, so the name survives a rebuild rather than going dead. Without it the
name is assumed to be fronted some other way, and unlisted branches — which is
almost all of them — keep the provider origin and never touch Cloudflare.

The stack is *configured* with whichever origin applies: `SITE_URL`, the
Supabase redirect allowlist, CORS, the frontend's public URLs, and the
`X-Forwarded-Host` the edge pins. That last one matters — Next.js rejects a
Server Action whose `x-forwarded-host` disagrees with its `origin`, and the only
symptom is a minified React error.

## Known limits

- OAuth initiation is the one deliberate exclusion.
- Creating a project needs managed-git credentials: `MANAGED_GIT_GITHUB_OWNER`
  plus either the full GitHub App configuration or `MANAGED_GIT_GITHUB_TOKEN`.
  Without them, provisioning answers 503 and every flow that needs a project
  fails.
- `deploy-preview.yml` is `pull_request_target` and checks out the **default
  branch**. Anything the workflow itself reads — files under `tests/`, a Worker
  under `infra/cloudflare/workers/` — must be on `main` first. The pull request
  only ever contributes the images.
