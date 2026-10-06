---
name: kortix-backends
description: "Build, deploy and operate Kortix Backends: full backends powered by self-hosted Convex (database, server functions, realtime queries, file storage, crons, full-text and vector search) with built-in Kortix sign-in. Use when an App or an agent needs persistent data, live updates, server-side logic, uploads, schedules or search; when the user asks for a database, an API, a backend, a data model, auth, or 'store this'; and before writing any Convex code. For a complete internal business app (backend + UI + sign-in) load kortix-internal-apps too."
---

# Kortix Backends

A Kortix backend is a full backend for the project, powered by **Convex**: a
transactional database, TypeScript server functions, realtime queries, file
storage, schedules, and search. Each backend is a self-hosted Convex instance in
its own always-on machine. Kortix provisions it, holds its admin key, and signs
members in to it.

Backends is an experimental project feature flag (`backends`), off by default
and available only where Kortix runs Platinum machines. While it is off, every
`kortix backends` command says so and exits `1`. Ask a project admin to enable
**Backends** in Settings → Feature flags.

## When to use one

Use a backend when an App or an agent needs data that outlives a session, live
updates in a UI, server functions that hold secrets or enforce rules, uploads,
scheduled jobs, or search. Use an App (kortix-apps) for the UI, project secrets
for credentials, and the repo for files that are source. The backend is the
data and logic behind the App.

## Where the code lives

A backend does not know about repositories. A deploy pushes code with the admin
key, so the Convex code can live anywhere:

- **Default:** the project repo, one directory per backend, named after it:
  `backends/<name>/package.json` + `backends/<name>/convex/`. It is versioned,
  reviewed and available to every session.
- **Also fine:** any other directory (`--dir`), a separate repository cloned
  into the sandbox, a laptop or CI with
  `eval "$(kortix backends env <name>)" && npx convex deploy`.

Deploy from the project repo unless the user says otherwise.

## The loop

```sh
mkdir -p backends/main && cd backends/main
npm init -y >/dev/null && npm install convex   # once
npx convex ai-files install                    # once: Convex's agent rules + skills (below)
# write convex/schema.ts, convex/*.ts, convex/auth.config.ts
cd - && kortix backends deploy main --dir backends/main
```

`kortix backends deploy <name> --dir <path>` creates the backend if it does not
exist, waits until it runs (seconds; minutes on a region's first image build),
then runs `npx convex deploy` there with the backend's credentials. Read the
output: a type error or a schema that existing documents violate fails the
deploy before anything changes. Fix and deploy again. Commit the Convex code on
the session branch like any other code.

| Command | Use |
| --- | --- |
| `kortix backends list` | Backends and their status (`provisioning`, `running`, `error`). |
| `kortix backends create <name>` | Create and wait, without deploying. |
| `kortix backends get <name> [--json]` | `url` (Convex client URL), `site_url` (HTTP actions), status. |
| `kortix backends env <name>` | Shell exports for the Convex CLI (admin). Use with `eval`. |
| `kortix backends token <name>` | A one-hour sign-in token naming you (see Sign-in). |
| `kortix backends deploy <name> --dir <path>` | Create if missing, then deploy. |
| `kortix backends delete <name> --yes` | Delete the machine and every document and file. |

A name is lowercase letters, digits and dashes, starting with a letter. A
project holds up to 3 backends. On `error`, delete the backend and create it
again.

## Convex's own agent material: install it at runtime

Convex publishes rules and task skills for coding agents. They override what
you remember about Convex. Install them in every backend directory, then read
them:

```sh
cd backends/main && npx convex ai-files install
```

- `convex/_generated/ai/guidelines.md` — the Convex coding rules. **Read it
  before your first change**, and again when a deploy fails on something you do
  not understand.
- `.agents/skills/convex*/SKILL.md` — task skills: `convex-design`,
  `convex-auth`, `convex-crons`, `convex-migrate`, `convex-test`,
  `convex-reviewer`, `convex-optimize`, `convex-seed`, `convex-agent` and more.
  Read the one that matches the task.
- `AGENTS.md`, `CLAUDE.md`, `skills-lock.json` — commit them with the backend.

Refresh with `npx convex ai-files update` after upgrading `convex`. Index of the
official docs for agents: https://docs.convex.dev/llms.txt.

A Kortix backend is **self-hosted** Convex. Ignore anything in that material
that needs Convex Cloud: `npx convex dev` login, deploy keys, preview
deployments, dashboard.convex.dev, custom domains (`convex-domains`), log
streams, and the Convex AI gateway. Convex Auth is not needed: use Kortix
sign-in. Where Convex material and this skill disagree on deploying,
credentials or auth, this skill wins.

Code patterns (schema, queries, mutations, actions, HTTP actions, crons, file
storage, search, migrations): [references/convex-patterns.md](references/convex-patterns.md).

## Sign-in: every backend knows the signed-in Kortix member

Kortix writes three variables into every backend at creation
(`KORTIX_AUTH_ISSUER`, `KORTIX_AUTH_AUDIENCE`, `KORTIX_AUTH_JWKS`). Add this
file and deploy:

```ts
// convex/auth.config.ts
export default {
  providers: [
    {
      type: "customJwt",
      issuer: process.env.KORTIX_AUTH_ISSUER!,
      applicationID: process.env.KORTIX_AUTH_AUDIENCE!,
      jwks: process.env.KORTIX_AUTH_JWKS!,
      algorithm: "ES256",
    },
  ],
};
```

Then in any function, `await ctx.auth.getUserIdentity()` returns the member
(`subject` = Kortix user id, `email`, `name`) or `null` for an anonymous call.
**The backend URL is public: every public function that reads or writes
non-public data must reject a `null` identity.** Who gets a token, the React
wiring, and the helper to copy: [references/sign-in.md](references/sign-in.md).

## Wire an App to the backend

The `url` is public, not secret. A static or SPA frontend reads it at build
time: put `VITE_CONVEX_URL=<url>` (Vite) or `NEXT_PUBLIC_CONVEX_URL=<url>`
(Next.js) in the App's committed `.env.production`, build, and deploy the built
directory with kortix-apps. A server-rendered App reads `CONVEX_URL` at runtime
from the App's `env` in `kortix.yaml`. The App fetches its sign-in token from
`/_kortix/backend-token` on its own origin (references/sign-in.md). The full
recipe is kortix-internal-apps.

## Read and write data as an agent

```sh
eval "$(kortix backends env main)"            # admin credentials into this shell only
cd backends/main
npx convex data                               # tables
npx convex data tasks --limit 20              # rows
npx convex run tasks:create '{"title":"…"}'   # run a function as admin
npx convex env set SOME_API_BASE https://…    # deployment env var for actions
npx convex logs                               # function logs
npx convex export --path /tmp/backup.zip      # data + files
```

An admin call has no identity: `ctx.auth.getUserIdentity()` is `null`, so a
function that requires sign-in rejects it. Act as a member in one of two ways:

- `npx convex run --identity '{"subject":"<user-id>","email":"a@example.com"}' tasks:create '{…}'`
  — admin only, fastest for testing your auth rules.
- `kortix backends token main` — a real token naming you; send it with a Convex
  client (`client.setAuth(token)`), exactly as an App does.

 Never run `npx convex dev` or `npx convex dashboard`
against a Kortix backend.

## Secrets and safety

- The admin key controls all code and data. Kortix audits every read
  (`backend.credentials.read`). Never print, log, commit or paste it, and never
  put it in an App, a bundle, `kortix.yaml` or a chat. Keep it in the shell via
  `eval "$(kortix backends env <name>)"`.
- Sign-in tokens are one-hour bearer tokens. Never commit or log them either.
- A deployment env var set with `npx convex env set` is readable by anyone with
  the admin key; put third-party credentials there only when an action needs
  them.

## Limits

- Up to 3 backends per project; fixed machine size 1 vCPU / 1 GB / 10 GB;
  always on; not metered while experimental.
- Data is SQLite on the machine disk, backed up with the disk. Writes are capped
  by Convex at about 4 MiB/s.
- No preview deployments, no AI gateway for `@convex-dev/agent` (call a model
  provider from an action), no Convex dashboard in Kortix yet (use the CLI).
- `npx convex export` covers data and files, not environment variables or
  pending scheduled jobs. Keep env var names (not values) in the repo.
- `kortix backends delete` destroys all data. Export first when it matters.
