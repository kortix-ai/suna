# `convex` Apps: data, server logic, realtime

A `convex` App is a full backend for the project: a transactional database,
TypeScript server functions, realtime queries, file storage, schedules and
search. It is a self-hosted **Convex** deployment in its own always-on
machine. Kortix provisions it, holds its admin key, and signs members in to
it (sign-in.md).

It is an App like any other: the same `kortix apps` commands, access
settings, size and budget fields. Its capabilities differ:
`deployments`, `snapshots`, `restore`, `admin_credentials`, `dashboard`,
`logs` and `member_tokens`. It has no `preview`, `rollback` or `sleep`:
`start`, `stop`, `rollback` and `access-link` answer
`409 app_capability_unsupported`.

`convex` needs Platinum machines. Where Kortix runs none, a create answers
`409 app_kind_unavailable`: build with the project's own storage and code
instead, and tell the user once.

## The split

The UI is a web App (static, SPA). Every piece of server logic lives in the
`convex` App: queries, mutations, actions (external APIs, npm, Node), HTTP
actions (REST endpoints, webhooks, public APIs on `instance.site_url`), crons
and scheduled jobs. Do not put server code in a web App that uses a `convex`
App.

A `convex` App is plain self-hosted Convex. Everything Convex works against
it with its URL and admin key (`kortix apps credentials`) or a member token:
the Convex CLI, the Convex MCP server (`npx convex mcp start` with the admin
env loaded), the JS, React and Python clients, the HTTP API, and Convex
components.

## Where the code lives

Default: the project repo, one directory per App, named after its slug:
`apps/db/package.json` + `apps/db/convex/`. It is versioned, reviewed and
available to every session. `kortix apps deploy apps/db` sees `convex/` and
deploys it as Convex code.

## The loop: six steps

Every task on a `convex` App runs these six steps in order. Skip none: step 3
keeps you from breaking what exists, and step 5 is the proof.

If `instance.url` is on `*.apps.localhost`, the project runs on a developer's
local Kortix stack, which this sandbox cannot reach. Do not probe the
network: write the change, say the App is unreachable from here, and give the
user the `kortix apps deploy` command to run on their machine.

**1. Install** (once per App directory):

```sh
mkdir -p apps/db && cd apps/db
npm init -y >/dev/null && npm install convex @kortix/sdk
npm install -D typescript @types/node   # so every deploy typechecks
npx convex ai-files install             # Convex's agent rules and skills (below)
```

Read `convex/_generated/ai/guidelines.md` before your first change. Pin
`convex` to the App's `instance.client_version`
(`kortix apps show db --json`) when they differ: a newer CLI can need
server APIs this deployment lacks. Check that `@kortix/sdk` exports
`requireKortixMember` (sign-in.md, "SDK version").

**2. Connect.** Create the App if `kortix apps ls` does not show it, then
load the admin credentials into this shell only:

```sh
kortix apps create db --kind convex         # only when it does not exist yet
eval "$(kortix apps credentials db)"        # CONVEX_SELF_HOSTED_URL + _ADMIN_KEY
kortix apps connect db                      # how an App, a script or a server reaches it
npx convex codegen --init                   # once: convex/tsconfig.json and convex/_generated
```

TypeScript 7 (the current `typescript` on npm) loads no `@types` package by
default: add `"types": ["node"]` to `compilerOptions` in
`convex/tsconfig.json`, or every `process.env` fails the typecheck.

**3. Discover** what is already there before you change anything:

```sh
npx convex function-spec                    # every deployed function, its args and returns
npx convex data                             # tables
npx convex data tasks --limit 20            # the 20 newest rows of one table
npx convex env list --names-only            # env var names; never print the values
kortix apps show db                         # status, size, health, last deployment
```

Read the code in `apps/db/convex/` too. When the deployed functions and the
repo code differ, ask the user which one is current.

**4. Change.** Edit the code, then push it and the data:

```sh
kortix apps deploy apps/db --app db                          # Convex code
npx convex env set SOME_API_BASE https://api.example.com     # a secret: omit the value, pipe it in on stdin
npx convex env remove SOME_API_BASE
npx convex run tasks:create '{"title":"…"}'                   # run a function as admin
npx convex import --table tasks --append tasks.jsonl          # bulk data in
npx convex export --path /tmp/db.zip --include-file-storage   # data and files out
```

`kortix apps deploy` waits until the App runs (seconds; up to 10 minutes on a
region's first image build), then runs `convex deploy` with the App's
credentials and records a deployment (`source_kind: "convex"`, the git
revision) so the App's history shows who deployed what. It uses the
directory's own `node_modules/.bin/convex`, else
`npx convex@<instance.client_version>`. A type error, or a schema that
existing documents violate, fails the deploy before anything changes. Fix
and deploy again. Take `kortix apps snapshot db` before a migration, a bulk
import or a destructive backfill.

**5. Verify** with real calls, never with the deploy output alone:

```sh
kortix apps logs db --lines 200                      # process log: crashes, restarts
timeout 20 npx convex logs --history 50              # function logs; it never exits by itself
npx convex run tasks:list '{}'                       # admin, no identity: must FAIL
TOKEN=$(kortix apps token db)                        # a real token: in a session it names the agent, not you
URL=$(kortix apps show db --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["app"]["url"])')
curl -s "$URL/api/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"path":"tasks:list","args":{},"format":"json"}'   # must answer "status":"success"
```

A UI that uses the App is verified in the browser (SKILL.md, Verify).

**6. Hand over.** Give the user the dashboard link and the way in:

```sh
kortix apps dashboard db     # Convex's dashboard inside Kortix: data, functions, logs, files
kortix apps connect db       # snippets for an App, a script, their own server
```

Commit the Convex code on the session branch like any other code.

## Commands

| Command | Use |
| --- | --- |
| `kortix apps create <slug> --kind convex` | Create and wait until it runs, without deploying. `--cpu`, `--memory`, `--disk`, `--uses`, `--no-wait`. |
| `kortix apps show <slug> [--json]` | `instance.url` (Convex client URL), `instance.site_url` (HTTP actions), `instance.status`, `instance.client_version`, `instance.health` (the last 5-minute probe: machine state, disk use), `capabilities`, `uses`, `used_by`. |
| `kortix apps deploy <dir> --app <slug> [-- <convex deploy args>]` | Deploy the Convex code in `<dir>/convex`. Exits with the Convex exit code. |
| `kortix apps credentials <slug> [--format shell\|dotenv\|json]` | The Convex CLI credentials (admin). `shell` (default) prints `export` lines for `eval`. Audited. |
| `kortix apps connect <slug>` | Working code to reach the App from another App, from outside, and from the CLI. No secret. |
| `kortix apps token <slug>` | A 15-minute sign-in token. A person's own login: names that person, with groups and role. An agent session: names the agent (`kind: "agent"`), with no groups and no role. |
| `kortix apps dashboard <slug>` | Link to Convex's dashboard inside Kortix. |
| `kortix apps logs <slug> [--lines N]` | The Convex process log (startup, crashes, restarts, request lines). 1–1000 lines, default 200. |
| `kortix apps snapshots <slug>` · `snapshot <slug>` · `delete-snapshot <slug> <id> --yes` · `restore <slug> <id> --yes` | Backups, snapshots (with kind and expiry), snapshot delete and point-in-time restore. |
| `kortix apps rotate-credentials <slug> --yes` | Replace the admin key; every key read before stops working. About 1 s of restart; data stays. |
| `kortix apps set <slug> --cpu N --memory GB --disk GB` | Resize now and wait (below). `--no-wait` returns when it starts. |
| `kortix apps delete <slug> --confirm <slug>` | Retire the App: final snapshot, machine kept 7 days, then purged. The typed slug is required. |

A slug is lowercase letters, digits and dashes. A project holds up to 3
`convex` Apps and an account 10 (`409 app_kind_limit`). On `instance.status:
error`, delete the App and create it again.

Never run `npx convex dev` or `npx convex dashboard` against a `convex` App:
both need a Convex Cloud login. The dashboard is in Kortix.

## Convex's own agent material: install it at runtime

Convex publishes rules and task skills for coding agents. They override what
you remember about Convex. `npx convex ai-files install` writes:

- `convex/_generated/ai/guidelines.md` — the Convex coding rules. **Read it
  before your first change**, and again when a deploy fails on something you
  do not understand.
- Task skills (`convex-design`, `convex-auth`, `convex-crons`,
  `convex-migrate`, `convex-test`, `convex-agent` and more) in each coding
  agent's skill path, for example `.agents/skills/convex*/SKILL.md`. Read the
  one that matches the task.
- `AGENTS.md`, `CLAUDE.md` (Convex sections) — commit them with the App.

Refresh with `npx convex ai-files update` after upgrading `convex`. Index of
the official docs for agents: https://docs.convex.dev/llms.txt.

A `convex` App is **self-hosted** Convex. Where Convex material and this
skill disagree on deploying, credentials or auth, this skill wins. These
parts of Convex need Convex Cloud and do not exist here:

| Convex Cloud feature | On a `convex` App |
| --- | --- |
| `npx convex dev`, deploy keys, preview deployments | `kortix apps deploy`; one deployment per App |
| dashboard.convex.dev, `npx convex dashboard` | `kortix apps dashboard <slug>` |
| `npx convex insights` | `kortix apps show` (health) and `npx convex logs` |
| Convex AI gateway (`@convex-dev/agent` without a key) | Call the model provider from an action with your own key in an env var |
| Custom domains (`convex-domains`) | Not available; the URLs are fixed per App |
| Log streams, exception reporting (Sentry, Datadog) | `kortix apps logs`, `npx convex logs`; send errors from an action yourself |
| Scheduled cloud backups ("Backup automatically") | Kortix's hourly automatic backup and snapshots (below) |
| Streaming export (Fivetran) | `npx convex export` |

Code patterns (schema, queries, mutations, actions, HTTP actions, crons, file
storage, search, migrations): convex-patterns.md.

## Database and durability

Convex itself is the database: documents, indexes, file storage and the
scheduler all live in the App. Do not add a second database next to it.

- **Storage:** Convex keeps its data in SQLite on the machine disk. Kortix
  measured SQLite against Postgres 17 in the same 2 vCPU machine: the same
  throughput and median latency (Convex's own CPU is the limit), 3.6× less
  disk for the same documents, and a lower realtime push p99 (0.25 s against
  1.45 s). SQLite is the only option today.
- **Scale up, not out:** Convex runs as one process on one machine. Resize
  with `kortix apps set`.
- **Writes:** Convex caps writes at about 4 MiB/s per deployment
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
  - Snapshots live on the machine's host. A host loss can take them with it;
    the automatic backup is the copy off the host.

  Tell the user this before they store data they cannot re-create, and keep
  an export of such data (`npx convex export --include-file-storage`) on
  their own schedule.

## Secrets and safety

- The admin key controls all code and data. Kortix audits every read
  (`app.credentials.read`). Never print, log, commit or paste it, and never
  put it in a web App, a bundle, `kortix.yaml` or a chat. Keep it in the
  shell via `eval "$(kortix apps credentials <slug>)"`.
- If the admin key leaked (printed, committed, pasted into a chat), rotate it:
  `kortix apps rotate-credentials <slug> --yes`, then
  `eval "$(kortix apps credentials <slug>)"` again. Tell the user: every
  `.env.local` holding the old key needs the new one.
- Sign-in tokens are 15-minute bearer tokens. Never commit or log them either.
- A deployment env var set with `npx convex env set` is readable by anyone
  with the admin key. Put a third-party credential there only when an action
  needs it, and set it from stdin so it stays out of the shell history.

## Size, backups and restore

A `convex` App is one machine. Size it for the load, and keep snapshots
before risky changes.

```sh
kortix apps create db --kind convex --cpu 2 --memory 4 --disk 20   # default 1 vCPU / 1 GB / 10 GB
kortix apps set db --cpu 4 --memory 8          # seconds of downtime; disk only grows
kortix apps snapshots db                       # automatic backup, schedule, snapshots with kind and expiry
kortix apps snapshot db                        # manual point-in-time copy, kept until deleted
kortix apps restore db <snapshot-id> --yes     # roll back; later changes are lost
```

- **Automatic backup:** Kortix copies the machine to object storage every
  hour. It recovers the App after a host loss. Nothing to configure.
- **Snapshot:** data, files, functions and env vars at one moment. Take one
  before a migration, a bulk import, or anything you might want to undo.
  Kinds: `manual` (yours, kept until deleted, 10 per App; the 11th answers
  `409 snapshot_limit`), `automatic` (Kortix, daily, kept 7 days), `resize`
  (Kortix, before a resize, kept 24 h or until the next resize replaces it)
  and `final` (Kortix, at delete). `expires_at` says when Kortix deletes one.
- **Restore:** rolls the running App back in place, in seconds. Every change
  after the snapshot is gone, so confirm with the user first. A snapshot from
  before a resize cannot be restored (`409 snapshot_predates_resize`): it
  holds the old machine size. A restore changes the admin key: run
  `eval "$(kortix apps credentials <slug>)"` again before the next `npx convex`.
- One operation at a time: snapshot, restore and snapshot delete answer
  `409 app_busy` while a resize, restore, rotation or recovery runs. Wait for
  `instance.operation` to clear (`kortix apps show <slug>`), then retry.
- Limits: 1–16 vCPU, 1–32 GB memory, 10–100 GB disk (disk can only grow).
- Kortix probes every `convex` App every 5 minutes, starts a stopped machine,
  and restores a lost one from its last automatic backup by itself (data
  since that backup is lost). `instance.operation: recovering` shows while it
  does.

## Cost, budget and limits

- A `convex` App is billed like a sandbox: reserved CPU, memory and disk × the
  time the machine runs. The default size costs about $59 for a 30-day month
  at list price. It is always on: `always_on: false` answers
  `400 app_always_on_required`.
- A `convex` App has no budget and no budget alert: `monthly_budget_usd` is
  `null` and `instance.budget_alert` is always `null`. A budget answers
  `400 app_budget_not_applicable`. The machine never stops for cost: a stopped
  database breaks every client. To lower the cost, shrink the machine.
- Up to 3 `convex` Apps per project and 10 per account.
- `instance.url` and `instance.site_url` are Kortix hosts. They never change
  while the App lives. Kortix proxies them, WebSocket included; the machine
  itself is not reachable. There is no upgrade in place: an App keeps the
  Convex image it was created with.
- `npx convex export` covers data and files, not environment variables or
  pending scheduled jobs. Keep env var names (not values) in the repo.

## Delete

`kortix apps delete <slug> --confirm <slug>` needs the slug typed as
confirmation (API: `confirm=<slug>`, else `400 confirmation_required`) and the
`project.app.admin` permission. Kortix takes a `final` snapshot, stops the
machine and keeps it 7 days (`retained_until`). The App's hosts answer `410`
meanwhile. After 7 days Kortix deletes the machine, its snapshots and every
document and file. Export first when the data matters.
