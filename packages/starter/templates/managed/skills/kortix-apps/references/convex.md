# The Convex template: data, server logic, realtime

A Convex backend is a plain Kortix App made from the `convex` template: the
self-hosted Convex backend image (pinned by digest), its data on a volume, two
services, and an admins-only dashboard App shown as a tab of it. Nothing about it is
special to Kortix: every command here works for any App.

Why two Apps: the backend and the dashboard are two different images, and a
Kortix App runs one image. The Apps page shows them as one: the dashboard is
the backend's Dashboard tab. The backend runs 24/7 with its volume; the
dashboard sleeps when idle.

It gives the project a transactional database, TypeScript server functions,
realtime queries, file storage, schedules and search, with Kortix sign-in.

## Launch

```sh
kortix apps launch --template convex
```

It writes two blocks into `kortix.yaml` and two files, then:

1. deploys `backend`;
2. runs `./generate_admin_key.sh` on the `backend` machine and writes the key to
   the project secret `BACKEND_ADMIN_KEY` (the slug in capitals, `-` → `_`). The
   key belongs to the backend just launched, so every launch rewrites it: a
   value left by an earlier App of the same name is stale. Convex derives it
   from the backend's instance secret, so it stays the same while the volume
   lives. The key is never printed;
3. deploys `backend-dashboard`.

| App | What it is |
| --- | --- |
| `backend` | The Convex backend: data, server functions, realtime queries, files. `http` service (port 3210, `access: public`, a `/version` check): the Convex client URL and sync WebSocket. `site` service (port 3211, `access: public`): HTTP actions, on `<backend host>--site`. A `data` volume at `/convex/data`. Always on, 1 vCPU / 1 GB. `display: { preview: none }`: an icon card. |
| `backend-dashboard` | Convex's dashboard, a Dockerfile App in `apps/backend/dashboard`, `access: admins`. It `uses: [backend]` and reaches it through its own origin (`/_kortix/apps/backend`). `display: { parent: backend }`: the Dashboard tab of `backend`, no card of its own. `secrets: { NEXT_PUBLIC_ADMIN_KEY: BACKEND_ADMIN_KEY }`: it opens signed in. |

The dashboard block holds no script and no shell:

```yaml
backend-dashboard:
  path: apps/backend/dashboard
  type: dockerfile
  command: [node, /kortix/start.js]
  labels: [backend, dashboard]
  display: { parent: backend }
  uses: [backend]
  always_on: false
  vm: { cpu: 1, memory_gb: 1 }
  http_service: { internal_port: 6791, access: admins }
  secrets: { NEXT_PUBLIC_ADMIN_KEY: BACKEND_ADMIN_KEY }
```

The files `launch` writes (a file that already exists is yours: kept):

| File | What it does |
| --- | --- |
| `apps/backend/dashboard/Dockerfile` | `FROM` Convex's dashboard image (pinned by digest), `ENV BACKEND=backend`, copies `start.js`. |
| `apps/backend/dashboard/start.js` | Runs Convex's dashboard on port 6792. On the App's port 6791 it serves `/` as a page that frames the dashboard and answers its `dashboard-credentials-request` (Convex's embedding protocol) with the admin key; every other path goes to the dashboard. If the dashboard exits, the machine exits and Kortix restarts it. |

Both services of `backend` are `public` on purpose: Convex enforces sign-in in its
functions (`requireMember`, sign-in.md). The dashboard is project admins only,
so its page may carry the key.

To open the dashboard: Apps → `backend` → Dashboard. A project admin lands in it
signed in, with no click.

### An App launched before the dashboard was a Dockerfile App

Its dashboard block runs an image with shell plumbing (or asks for the admin
key and shows as its own card). Bring it up to date:

1. Get the two files: run
   `kortix apps launch --template convex --no-deploy` in a scratch
   directory and copy `apps/backend/dashboard/` into the project, or copy them
   from this skill's template source.
2. Replace the `backend-dashboard` block with the block above, and add
   `display: { preview: none }` to the `backend` block if it is missing.
3. Write the key without printing it:
   `kortix apps exec backend -- sh -c "cd /convex && ./generate_admin_key.sh" | tail -n 1 | kortix secrets set BACKEND_ADMIN_KEY=-`
4. Deploy the dashboard: `kortix apps deploy --manifest-app backend-dashboard`.
   The backend needs no redeploy.

## The split

The UI is a static App (SPA). Every piece of server logic lives in the backend:
queries, mutations, actions (external APIs, npm, Node), HTTP actions (REST
endpoints, webhooks on the `site` URL), crons and scheduled jobs. Do not put
server code in the UI App.

## Where the code lives

The project repo, one directory per App, named after its slug:
`apps/backend/package.json` + `apps/backend/convex/`. Versioned, reviewed, available to
every session.

## The loop: six steps

Every task on the backend runs these six steps in order. Skip none: step 3
keeps you from breaking what exists, and step 5 is the proof.

If the App's URL is on `*.apps.localhost`, the project runs on a developer's
local Kortix stack, which this sandbox cannot reach. Write the change, say the
App is unreachable from here, and give the user the commands to run.

**1. Install** (once per App directory):

```sh
mkdir -p apps/backend && cd apps/backend
npm init -y >/dev/null && npm install convex@1.46.0 @kortix/sdk
npm install -D typescript @types/node
npx convex ai-files install             # Convex's agent rules and skills (below)
```

Read `convex/_generated/ai/guidelines.md` before your first change. Keep
`convex` at the version the template pins (1.46.0): a newer CLI can need
server APIs this backend lacks.

**2. Connect.** `launch` stored the admin key as the project secret
`BACKEND_ADMIN_KEY`, and a session has it in its environment. Load it into the
shell only:

```sh
export CONVEX_SELF_HOSTED_URL=$(kortix apps show backend --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["app"]["url"])')
export CONVEX_SELF_HOSTED_ADMIN_KEY="$BACKEND_ADMIN_KEY"
kortix apps auth-env backend | while IFS='=' read -r k v; do printf '%s' "$v" | npx convex env set "$k"; done
npx convex codegen --init                   # once: convex/tsconfig.json and convex/_generated
```

`auth-env` sets `KORTIX_AUTH_ISSUER`, `KORTIX_AUTH_AUDIENCE` and
`KORTIX_AUTH_JWKS` (the key set as a `data:` URL) on the Convex deployment, so
`convex/auth.config.ts` (sign-in.md) verifies Kortix tokens. TypeScript 7 loads
no `@types` package by default: add `"types": ["node"]` to `compilerOptions`
in `convex/tsconfig.json`.

**3. Discover** what is already there before you change anything:

```sh
npx convex function-spec                    # every deployed function, its args and returns
npx convex data                             # tables
npx convex data tasks --limit 20            # the 20 newest rows of one table
npx convex env list --names-only            # env var names; never print the values
kortix apps machines backend                # the machine: state, release, volume
```

Read the code in `apps/backend/convex/` too. When the deployed functions and the
repo code differ, ask the user which one is current.

**4. Change.** Edit the code, then push it and the data:

```sh
npx convex deploy -y                                           # functions, schema, indexes
npx convex env set SOME_API_BASE https://api.example.com       # a secret: omit the value, pipe it in on stdin
npx convex run tasks:create '{"title":"…"}'                     # run a function as admin
npx convex import --table tasks --append tasks.jsonl            # bulk data in
npx convex export --path /tmp/backend.zip --include-file-storage # data and files out
```

A type error, or a schema that existing documents violate, fails the push
before anything changes. Take `kortix apps volumes snapshot backend data` before a
migration, a bulk import or a destructive backfill.

**5. Verify** with real calls, never with the push output alone:

```sh
timeout 20 npx convex logs --history 50              # function logs; it never exits by itself
npx convex run tasks:list '{}'                       # admin, no identity: must FAIL
TOKEN=$(kortix apps token backend)                   # a real token: in a session it names the agent
curl -s "$CONVEX_SELF_HOSTED_URL/api/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"path":"tasks:list","args":{},"format":"json"}'   # must answer "status":"success"
```

A UI that uses the backend is verified in the browser (SKILL.md, Verify).

**6. Hand over.** The dashboard (project admins, signed in): Apps → `backend` →
Dashboard, or a direct link:

```sh
kortix apps access-link backend-dashboard --json # access_session.url, valid 5 minutes
```

Commit the Convex code on the session branch like any other code.

## Convex's own agent material

`npx convex ai-files install` writes `convex/_generated/ai/guidelines.md` (the
Convex coding rules: read it before your first change), task skills
(`convex-design`, `convex-auth`, `convex-migrate`, …) and Convex sections in
`AGENTS.md`/`CLAUDE.md`. Refresh with `npx convex ai-files update` after
upgrading `convex`. Docs index for agents: https://docs.convex.dev/llms.txt.

The backend is **self-hosted** Convex. Where Convex material and this skill
disagree on deploying, credentials or auth, this skill wins:

| Convex Cloud feature | Here |
| --- | --- |
| `npx convex dev`, deploy keys, preview deployments | `npx convex deploy` with the admin key; no preview deployments (a volume fork is a point-in-time copy inside the same App) |
| dashboard.convex.dev | the `backend-dashboard` App: the Dashboard tab of `backend` |
| Convex AI gateway | call the model provider from an action with your own key |
| Log streams, exception reporting | `npx convex logs`, `kortix apps logs backend` |
| Scheduled cloud backups | daily volume snapshots (below) |

Code patterns (schema, queries, mutations, actions, HTTP actions, crons, file
storage, search, migrations): convex-patterns.md.

## Data and durability

- Convex keeps its data in SQLite on the App's `data` volume. Do not add a
  second database next to it.
- The volume outlives every release and every machine. A redeploy (`rolling`)
  stops the old machine, detaches the volume and mounts it on the new one:
  seconds of downtime, no data loss. A hard kill of the machine or its host
  loses no acknowledged write (measured on Platinum, 2026-10-10: 0 of 27
  crash cycles lost data).
- Run **one** machine. Scaling the group above 1 gives each machine its own,
  empty volume: two independent databases behind one URL.
- Writes: Convex caps them at about 4 MiB/s per deployment (`TooManyWrites`).
  Batch a bulk import and retry with backoff.

## Snapshots, restore, fork

```sh
kortix apps volumes snapshots backend data     # daily (kept 5 days by default), manual, final
kortix apps volumes snapshot backend data      # before a risky change
kortix apps volumes restore backend data <snapshot> # admins: the machine stops, the volume returns, the machine starts
kortix apps volumes fork backend data data_copy  # an instant, unattached point-in-time copy in the same App
```

A restore is a new version of the volume: nothing is lost, the replaced
contents stay in its history. Confirm with the user before a restore anyway:
the live data goes back to the snapshot.

## Secrets and safety

- The admin key controls all code and data. Never print, log, commit or paste
  it, and never put it in a web App, a bundle, `kortix.yaml` or a chat. A
  leaked key cannot be rotated in place today: export the data
  (`npx convex export --include-file-storage`), launch a new backend App,
  import it there, then delete the old App.
- Sign-in tokens are 15-minute bearer tokens. Never commit or log them.
- A Convex env var is readable by anyone with the admin key. Set secrets from
  stdin so they stay out of the shell history.

## Size

- The backend is one always-on machine of 1 vCPU / 1 GB. Change `vm` in its
  `kortix.yaml` block and deploy to resize (a new release; the volume keeps the
  data).
- The dashboard is on demand: it runs only while someone has it open.
- Apps have no monthly budget: account credits pay.

## Delete

`kortix apps delete backend --yes` removes the machines and images. Its volumes keep
a final snapshot for 7 days, then Kortix purges them. To keep the data,
`npx convex export --include-file-storage` first.
