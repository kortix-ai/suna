---
name: kortix-backends
description: "Build, deploy and operate Kortix Backends: self-hosted Convex (database, server functions, realtime queries, file storage, crons, full-text and vector search) with built-in Kortix sign-in. Load ONLY when the `backends` feature is on in this project (`kortix backends list` exits 0, or `kortix projects info --json` has `experimental.backends: true`) or the user names a Kortix Backend. Then use it when an App or an agent needs persistent data, live updates, server-side logic, uploads, schedules or search; when the user asks for a database, an API, a backend, a data model, auth, or 'store this'; and before writing any Convex code. When the feature is off, do not load it: build with the project's own storage and code. For a complete internal business app (backend + UI + sign-in) load kortix-internal-apps too."
---

# Kortix Backends

A Kortix backend is a full backend for the project, powered by **Convex**: a
transactional database, TypeScript server functions, realtime queries, file
storage, schedules, and search. Each backend is a self-hosted Convex instance in
its own always-on machine. Kortix provisions it, holds its admin key, and signs
members in to it.

Backends is an experimental project feature flag (`backends`), off by default
and available only where Kortix runs Platinum machines. While it is off, every
`kortix backends` command says so and exits `1`. Kortix enables it per project.
When it is on, `kortix projects features` lists `backends on kortix` and
`kortix projects info --json` has `experimental.backends: true`. Only Kortix
changes it: `kortix projects features enable|disable backends` answers
`feature_operator_only`.

**When the flag is off, do not stop.** Do the task without a Kortix backend:
use the storage and code the project already has (files in the project repo,
a database the project already uses, or a server App per kortix-apps). Tell
the user once that Kortix can enable Backends for the project if they want a
managed Convex backend with Kortix sign-in. Do not repeat it, and do not wait
for an answer before you build.

## When to use one

Use a backend when an App or an agent needs data that outlives a session, live
updates in a UI, server functions that hold secrets or enforce rules, uploads,
scheduled jobs, or search. Use an App (kortix-apps) for the UI, project secrets
for credentials, and the repo for files that are source. The backend is the
data and logic behind the App.

**The split is strict:** the App is frontend only (a static build); every piece
of server logic lives in the backend — queries, mutations, actions (external
APIs, npm, Node), HTTP actions (REST endpoints, webhooks, public APIs on
`site_url`), crons and scheduled jobs. Do not put server code in an App that has
a backend.

A Kortix backend is plain self-hosted Convex. Everything Convex works against it
directly with its URL and admin key (`kortix backends env`) or a member token:
the Convex CLI, the Convex MCP server (`npx convex mcp start` with the admin
env loaded), the JS, React and Python clients, the HTTP API, and Convex
components. Kortix adds provisioning, credentials, sign-in, sizing and backups.

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

## The loop: six steps

Every backend task runs these six steps in order. Skip none: step 3 keeps you
from breaking what exists, and step 5 is the proof.

**1. Install** (once per backend directory):

```sh
mkdir -p backends/main && cd backends/main
npm init -y >/dev/null && npm install convex @kortix/sdk
npm install -D typescript @types/node   # so every deploy typechecks
npx convex ai-files install             # Convex's agent rules and skills (below)
```

Read `convex/_generated/ai/guidelines.md` before your first change. Pin
`convex` to the backend's `convex_version` (`kortix backends get main --json`)
when they differ: a newer CLI can need backend APIs this backend lacks.
Check that `@kortix/sdk` exports `requireKortixMember` (references/sign-in.md,
"SDK version").

**2. Connect.** Create the backend if `kortix backends list` does not show it,
then load the admin credentials into this shell only:

```sh
kortix backends create main                 # only when it does not exist yet
eval "$(kortix backends env main)"          # CONVEX_SELF_HOSTED_URL + _ADMIN_KEY
kortix backends connect main                # how an App, a script or a server reaches it
npx convex codegen --init                   # once: convex/tsconfig.json and convex/_generated
```

TypeScript 7 (the current `typescript` on npm) loads no `@types` package by
default: add
`"types": ["node"]` to `compilerOptions` in `convex/tsconfig.json`, or every
`process.env` fails the typecheck.

**3. Discover** what is already there before you change anything:

```sh
npx convex function-spec                    # every deployed function, its args and returns
npx convex data                             # tables
npx convex data tasks --limit 20            # the 20 newest rows of one table
npx convex env list --names-only            # env var names; never print the values
kortix backends get main                    # status, size, health
```

Read the code in `backends/main/convex/` too. When the deployed functions and
the repo code differ, ask the user which one is current.

**4. Change.** Edit the code, then push it and the data:

```sh
cd - && kortix backends deploy main --dir backends/main     # --create only for a new backend
npx convex env set SOME_API_BASE https://api.example.com    # a secret: omit the value, pipe it in on stdin
npx convex env remove SOME_API_BASE
npx convex run tasks:create '{"title":"…"}'                  # run a function as admin
npx convex import --table tasks --append tasks.jsonl         # bulk data in
npx convex export --path /tmp/main.zip --include-file-storage # data and files out
```

`kortix backends deploy <name> --dir <path>` waits until the backend runs
(seconds; up to 10 minutes on a region's first image build), then runs
`convex deploy` there with the backend's credentials. It uses the project's own
`node_modules/.bin/convex`, or `npx convex@<convex_version>`. When no backend
has that name, `deploy` exits `1` and lists the existing names: check the name,
and pass `--create` only when you mean to create a new backend. A type error,
or a schema that existing documents violate, fails the deploy before anything
changes. Fix and deploy again. Take `kortix backends snapshot main` before a
migration, a bulk import or a destructive backfill.

**5. Verify** with real calls, never with the deploy output alone:

```sh
kortix backends logs main --lines 200                  # process log: crashes, restarts
timeout 20 npx convex logs --history 50                # function logs; it never exits by itself
npx convex run tasks:list '{}'                         # admin, no identity: must FAIL
TOKEN=$(kortix backends token main)                    # a real token: in a session it names the agent, not you
curl -s "$(kortix backends get main --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["backend"]["url"])')/api/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"path":"tasks:list","args":{},"format":"json"}'  # must answer "status":"success"
```

An App's UI is verified in the browser (kortix-internal-apps).

**6. Hand over.** Give the user the dashboard link and the way in:

```sh
kortix backends dashboard main     # Convex's dashboard inside Kortix: data, functions, logs, files
kortix backends connect main       # snippets for an App, a script, their own server
```

Commit the Convex code on the session branch like any other code.

| Command | Use |
| --- | --- |
| `kortix backends list` | Backends and their status (`provisioning`, `running`, `error`). |
| `kortix backends create <name>` | Create and wait, without deploying. `--cpu`, `--memory`, `--disk`. |
| `kortix backends get <name> [--json]` | `url` (Convex client URL), `site_url` (HTTP actions), status, `convex_version`, and `health` (the last 5-minute probe: machine state, disk use). |
| `kortix backends logs <name> [--lines N]` | The Convex process log (startup, crashes, restarts, request lines). |
| `kortix backends rotate-key <name> --yes` | Replace the admin key; every key read before stops working. About 1 s of restart; data stays. |
| `kortix backends dashboard <name>` | Link to the backend's admin dashboard in Kortix. If `--json` shows `dashboard_available: false`, use the Convex CLI. |
| `kortix backends connect <name> [--json]` | Working code to reach the backend from an App, from outside, and from the CLI. No secret. |
| `kortix backends env <name>` | Shell exports for the Convex CLI (admin). Use with `eval`. |
| `kortix backends token <name>` | A 15-minute sign-in token. A person's own login: names that person, with groups and role. An agent session: names the agent (`kind: "agent"`), with no groups and no role. |
| `kortix backends deploy <name> --dir <path> [--create]` | Deploy. `--create` creates a missing backend first. |
| `kortix backends resize <name> --cpu N --memory GB --disk GB` | Resize (see Size, backups and restore). |
| `kortix backends backups <name>` · `snapshot <name>` · `restore <name> <id>` | Backups and point-in-time restore. |
| `kortix backends delete <name> --yes` | Delete the machine and every document and file. |

A name is lowercase letters, digits and dashes, starting with a letter. A
project holds up to 3 backends and an account 10 (`409 backend_limit`). On
`error`, delete the backend and create it again.

Never run `npx convex dev` or `npx convex dashboard` against a Kortix backend:
both need a Convex Cloud login. The dashboard is in Kortix.

## Convex's own agent material: install it at runtime

Convex publishes rules and task skills for coding agents. They override what
you remember about Convex. `npx convex ai-files install` writes:

- `convex/_generated/ai/guidelines.md` — the Convex coding rules. **Read it
  before your first change**, and again when a deploy fails on something you do
  not understand.
- Task skills (`convex-design`, `convex-auth`, `convex-crons`, `convex-migrate`,
  `convex-test`, `convex-agent` and more) in each coding agent's skill path,
  for example `.agents/skills/convex*/SKILL.md`. Read the one that matches the
  task.
- `AGENTS.md`, `CLAUDE.md` (Convex sections) — commit them with the backend.

Refresh with `npx convex ai-files update` after upgrading `convex`. Index of the
official docs for agents: https://docs.convex.dev/llms.txt.

A Kortix backend is **self-hosted** Convex. Where Convex material and this
skill disagree on deploying, credentials or auth, this skill wins. These parts
of Convex need Convex Cloud and do not exist here:

| Convex Cloud feature | On a Kortix backend |
| --- | --- |
| `npx convex dev`, deploy keys, preview deployments | `kortix backends deploy`; one deployment per backend |
| dashboard.convex.dev, `npx convex dashboard` | `kortix backends dashboard <name>` |
| `npx convex insights` | `kortix backends get` (health) and `npx convex logs` |
| Convex AI gateway (`@convex-dev/agent` without a key) | Call the model provider from an action with your own key in an env var |
| Custom domains (`convex-domains`) | Not available; the URLs are fixed per backend |
| Log streams, exception reporting (Sentry, Datadog) | `kortix backends logs`, `npx convex logs`; send errors from an action yourself |
| Scheduled cloud backups ("Backup automatically") | Kortix's hourly automatic backup and snapshots (below) |
| Streaming export (Fivetran) | `npx convex export` |

Code patterns (schema, queries, mutations, actions, HTTP actions, crons, file
storage, search, migrations): [references/convex-patterns.md](references/convex-patterns.md).

## Sign-in: every backend knows the signed-in Kortix member

Kortix writes three variables into every backend at creation
(`KORTIX_AUTH_ISSUER`, `KORTIX_AUTH_AUDIENCE`, `KORTIX_AUTH_JWKS`). Add
`convex/auth.config.ts` and `convex/lib/auth.ts` exactly as
[references/sign-in.md](references/sign-in.md) shows, and deploy. Then every
public function starts with:

```ts
const me = await requireMember(ctx);                          // any Kortix member
const me = await requireMember(ctx, { groups: ["Finance"] }); // one Kortix group
```

`me` is `{ userId, email, name, picture, groups, groupIds, role, accountId,
projectId }`. Anonymous, outside the group, or signed in through another
provider throws `KortixMemberError`. **The backend URL is public: every public
function that reads or writes non-public data must call it first.**

`requireKortixMember` comes from `@kortix/sdk`. It is newer than the npm
release 0.13.52: check with `npm view @kortix/sdk version` and the test in
sign-in.md, which also gives the fallback until the release is on npm.

sign-in.md is the one place for the details: the App wiring
(`convex.setAuth(kortixAppBackendToken("main"))`, the build-time backend URL),
who gets a token, groups and roles, troubleshooting, and Convex Auth for
customers who are not Kortix members. kortix-internal-apps is the full recipe
for an App on a backend.

## Call Kortix and connectors from the backend

A Convex action can call Kortix connectors (Gmail, a CRM, any connected
system) through `@kortix/sdk`. Prefer a connector over a raw provider API key:
the connector gateway applies the project's policy, approvals and audit.

- **The credential is a human step.** Kortix does not mint a credential for
  backend code. Ask the user to create a service account and grant it a role:
  `kortix tokens service-accounts new <name>` (the bearer prints once) and
  `kortix access grant --service-account <id> --role member --project <id>`.
  An agent session cannot do this for them. They store the bearer with
  `npx convex env set KORTIX_API_KEY` (value on stdin). Build the rest while
  you wait.
- Set `KORTIX_API_URL` (the Kortix API with `/v1`, `https://api.kortix.com/v1`
  on Kortix cloud) and `KORTIX_PROJECT_ID` with `npx convex env set`. A
  `"use node"` action then runs `createKortix({ backendUrl:
  process.env.KORTIX_API_URL!, getToken: async () => process.env.KORTIX_API_KEY! })`
  and calls `.project(process.env.KORTIX_PROJECT_ID!).connectors.call(...)`.
- A service account reaches only the project's shared connector accounts,
  never a member's private account.
- To start an agent from the backend, POST the project's webhook trigger from
  an action, with its secret in a Convex env var (kortix-system, scheduling).

Recipes and error answers: kortix-connectors.

## Database and durability

Convex itself is the database: documents, indexes, file storage and the
scheduler all live in the backend. Do not add a second database next to it.

- **Storage:** Convex keeps its data in SQLite on the machine disk. Kortix
  measured SQLite against Postgres 17 in the same 2 vCPU machine: the same
  throughput and median latency (Convex's own CPU is the limit), 3.6× less
  disk for the same documents, and a lower realtime push p99 (0.25 s against
  1.45 s). SQLite is the default and the only option today.
- **External Postgres** is a possible future opt-in. It does not scale a
  backend out: Convex still runs as one process on one machine. Scale up with
  `kortix backends resize`.
- **Writes:** Convex caps writes at about 4 MiB/s per backend
  (`TooManyWrites`). Batch a bulk import and retry with backoff.
- **What is safe:** a machine stop and start, a resize, and a crash of the
  Convex process lose no acknowledged write (measured).
- **What is not yet safe:** the machine disk has no file system journal
  (kortix-ai/platinum#1450). A host crash or a hard reset of the machine can
  lose the last acknowledged writes or corrupt the data directory.
  - After a host loss, Kortix restores the machine from its last automatic
    backup by itself: **up to 1 hour of writes is lost (RPO ≤ 60 min).**
  - A corrupt data directory keeps Convex from starting. Kortix is alerted
    after 3 failed health probes (15 minutes). Restore the newest snapshot
    with the user's consent.

  Tell the user this before they store data they cannot re-create, and keep
  an export of such data (`npx convex export --include-file-storage`) on
  their own schedule.

## Secrets and safety

- The admin key controls all code and data. Kortix audits every read
  (`backend.credentials.read`). Never print, log, commit or paste it, and never
  put it in an App, a bundle, `kortix.yaml` or a chat. Keep it in the shell via
  `eval "$(kortix backends env <name>)"`.
- If the admin key leaked (printed, committed, pasted into a chat), rotate it:
  `kortix backends rotate-key <name> --yes`, then `eval "$(kortix backends env <name>)"`
  again. Tell the user: every `.env.local` holding the old key needs the new one.
- Sign-in tokens are 15-minute bearer tokens. Never commit or log them either.
- A deployment env var set with `npx convex env set` is readable by anyone with
  the admin key. Put a third-party credential there only when an action needs
  it, and set it from stdin so it stays out of the shell history.

## Size, backups and restore

A backend is one machine. Size it for the load, and keep snapshots before risky
changes.

```sh
kortix backends create main --cpu 2 --memory 4 --disk 20   # default 1 vCPU / 1 GB / 10 GB
kortix backends resize main --cpu 4 --memory 8             # seconds of downtime; disk only grows
kortix backends backups main                                # automatic backup + snapshots
kortix backends snapshot main                               # point-in-time copy (newest 5 kept)
kortix backends restore main <snapshot-id> --yes            # roll back; later changes are lost
```

- **Automatic backup:** Kortix copies the machine to object storage every hour.
  It recovers the backend after a host loss. Nothing to configure.
- **Snapshot:** data, files, functions and env vars at one moment. Take one
  before a migration, a bulk import, or anything you might want to undo. A
  resize takes one for you.
- **Restore:** rolls the running backend back in place, in seconds. Every
  change after the snapshot is gone, so confirm with the user first.
- Limits: 1–16 vCPU, 1–32 GB memory, 10–100 GB disk (disk can only grow).
- For portable copies outside Kortix:
  `npx convex export --path <file>.zip --include-file-storage`. Without
  `--include-file-storage` the export has no files.
- Kortix probes every backend every 5 minutes, starts a stopped machine, and
  restores a lost one from its last automatic backup by itself (data since that
  backup is lost). `operation: recovering` shows while it does.

## Cost and limits

- A backend is billed like a sandbox: reserved CPU, memory and disk × the time
  the machine runs. The default size costs about $59 for a 30-day month at list
  price. It is always on: it never idles to a stop. Delete a backend nobody
  uses.
- Up to 3 backends per project and 10 per account; one machine each (scale up
  with resize, not out).
- The backend URL is the machine's provider URL. It does not change while the
  backend lives. There is no stable Kortix hostname and no upgrade in place: a
  backend keeps the Convex image it was created with.
- `npx convex export` covers data and files, not environment variables or
  pending scheduled jobs. Keep env var names (not values) in the repo.
- `kortix backends delete` destroys all data. Export first when it matters.
