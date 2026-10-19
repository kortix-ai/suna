---
name: kortix-apps
description: "Build, deploy and operate Kortix Apps through the pre-authenticated CLI or SDK: static sites and SPAs, Dockerfile or OCI servers, workers, and stateful backends (a database, a Convex backend) with persistent volumes, snapshots and built-in Kortix sign-in. Use when the user asks to publish, host, deploy, preview, inspect, scale, wake, suspend, roll back, debug, or remove an App; asks for a database, an API, a backend, a data model, auth, or 'store this'; asks for an internal tool, business app, CRM, tracker, dashboard, portal, or any app the team logs in to; before writing any Convex code; or asks what an App costs or how it runs."
---

# Kortix Apps

Kortix Apps are built from three parts:

- **Release:** every deploy is an immutable release (v1, v2, …): the build
  plus its config. Rollback is a new release from an old one.
- **Machine:** a server App runs machines per **process group**. A machine
  keeps its id across releases; each release replaces its box.
- **Volume:** a persistent disk a machine mounts. It outlives every release
  and every machine, and keeps daily snapshots.

An App is one project-scoped thing: a stable URL, an access policy, labels,
its releases, machines and volumes. A static App is files Kortix serves itself
(no machine). Every App says what it supports in `app.capabilities`:
`deployments`, `rollback`, `preview`, `member_tokens`, plus `static`, or
`sleep` · `machines` · `scale` · `exec` for a server, plus `volumes` ·
`snapshots` when it has volumes. Branch on capabilities only.

Kortix chooses and operates the provider. Never select Cloudflare, Vercel, or
another host. Volumes need Platinum (the default on Kortix Cloud).

## Preflight

1. Run `pwd` and inspect the intended source directory before deploying.
2. Run `kortix projects info --json`. Read `project_id`.
3. Apps are generally available. Use Apps directly without checking a feature
   flag or routing to an alternative.
4. Do not create an empty App identity first: `kortix apps deploy` and
   `kortix apps launch` create it.
5. Never run `kortix apps deploy` from an uninspected workspace root. It can
   publish unrelated files as a static App.
6. New Apps are private. Choose another access mode only when the user asks.

## Choose what to build

| The user wants | Build | Reference |
| --- | --- | --- |
| A website or UI with no stored data | A static App | references/web-static.md |
| An app with data, login or realtime (an internal tool, a CRM, a tracker) | A Convex backend App (`kortix apps launch --template convex`) + a static App for the UI that uses it | "Internal apps" below, references/convex.md |
| A backend (data, functions, realtime) or an API only | The Convex template | references/convex.md |
| A server of its own (SSR, native packages, a custom service), a worker, several process groups | A server App | references/web-server.md, references/apps-model.md |
| A call to an external system from an App | The connector gateway | references/connectors.md |

Default to static for every UI. Server logic for a UI (queries, writes,
webhooks, integrations, schedules) lives in the backend App, not in a second
server.

## Where the code lives

Default: one folder per App, `apps/<slug>/`, named after its `kortix.yaml` key:
`apps/storefront/` (a static UI, built to `apps/storefront/dist`), `apps/api/`
(a server App with its `Dockerfile`), `apps/backend/` (a Convex backend's
`package.json` and `convex/`). Templates, `launch` and every example here use
it. It is a default, not a rule: `path` is free-form, so group the code by team
or topic when that fits the project better (`apps/sales/crm`,
`apps/ops/fieldops-backend`).

## Deploy

```bash
kortix apps launch --template convex           # a ready-made backend App, deployed
kortix apps deploy apps/storefront/dist --slug storefront --name Storefront --type static --spa
kortix apps deploy apps/api --slug api --type dockerfile --on-demand \
  --command '["node","server.js"]' --port 3000 --readiness-path /health
```

The command waits for `ready` for up to 1200 s. Use `--app <slug>` (or the
`kortix.yaml` block) for every later release of the same App. Never create a
new slug for a normal update.

Declare Apps in `kortix.yaml` `apps.<slug>` (kortix-system,
`references/kortix/kortix-yaml.md`). `kortix apps deploy` with no arguments
deploys every block, used Apps first; `kortix apps deploy <path>` uses the
block whose `path` it is. The keys:

```yaml
apps:
  api:
    path: apps/api
    type: dockerfile
    command: ["node", "server.js"]
    labels: [backend]
    display: { preview: none }     # where Kortix shows it: listed, preview (live | none), parent (a tab of another App)
    processes: { app: "", worker: "node worker.js" }   # "" = the image's command
    vm: [{ cpu: 1, memory_gb: 2 }, { cpu: 1, memory_gb: 1, processes: [worker] }]
    mounts:
      - { source: data, destination: /data, initial_size_gb: 10, processes: [app] }
    http_service:
      internal_port: 3000
      access: app                  # public | app (the App's policy) | admins
      auto_stop_machines: stop     # off | stop (suspend: like stop, today)
      min_machines_running: 0
      checks: [{ type: http, path: /health }]
    services:
      - { name: site, internal_port: 3001, access: public }   # → <host>--site
    deploy: { strategy: rolling, release_command: "node migrate.js" }
```

`kortix validate` checks these rules before a deploy; the API refuses the same
config with `400 app_config_invalid` and `issues: [{path, message}]`.

## Machines, scale, exec

```bash
kortix apps releases <app>                     # v1, v2, …; strategy; the live one
kortix apps machines <app>                     # id, group, state, release, size, volume
kortix apps machines stop|start|restart <app> <machine>
kortix apps scale count <app> 3 --process worker
kortix apps exec <app> -- ls /data             # project admins; output and exit code
```

A group with a mount runs one machine: `scale count` above 1 answers
`409 volume_single_machine`. Scale a database up with `kortix apps set <app>
--cpu <n> --memory-gb <n>` (then deploy). `--new-volumes` gives every new
machine its own, EMPTY volume: only for software that replicates itself.

## Volumes and snapshots

```bash
kortix apps volumes <app>
kortix apps volumes snapshots <app> <volume>        # daily (kept snapshot_retention_days), manual, final
kortix apps volumes snapshot <app> <volume>         # before a risky change
kortix apps volumes restore <app> <volume> <snapshot>   # admins: its machine stops and comes back on it
kortix apps volumes fork <app> <volume> <name>      # an instant, unattached copy (a preview with real data)
kortix apps volumes set <app> <volume> --retention 30   # keep daily snapshots 30 days
```

One machine writes a volume at a time; Kortix enforces it. A release with a
mount deploys `rolling` (stop the old machine, detach, mount on the new one):
seconds of downtime, no data loss.

## Access

```bash
kortix apps access <app> --mode private|project|restricted|password|public
kortix apps access <app> --mode restricted --members <member-id> --groups <group-id>
kortix apps access-link <app> --json      # a 5-minute signed browser link
```

- `private` (default): the creator and project managers. `project`: every
  project reader. `restricted`: chosen members and groups. `password`: anyone
  with the password. `public`: no authentication.
- A service's own `access` overrides it on that service's host: `public` (no
  gate; the service checks sign-in itself, like a backend whose functions call
  `requireKortixMember`), `app` (the App's policy), `admins` (project admins).
- Never write a password into `kortix.yaml`, source, logs, or a shared command.
- An unchanged access write does not sign anyone out; a changed one revokes
  App browser sessions.

## Acting as the viewer

An App that calls the Kortix API for each person who opens it must act as that
person, never as one shared key.

```bash
kortix apps access <app> --viewer api
```

- `identity` (default) signs the viewer's id, email and groups into every
  request (`x-kortix-app-viewer`); `api` adds a one-hour token that acts as
  them (`x-kortix-app-viewer-token`); `off` sends neither.
- On the App's server: `createAppViewerKortix(request, { backendUrl })` from
  `@kortix/sdk/server`, one client per request.
- In the browser: `createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken() })`
  from `@kortix/sdk`. Never call `https://api.kortix.com/v1` from the browser.
- Never give the App a personal PAT or API key. Never log the viewer headers.

## Apps that use other Apps

`kortix apps link <app> --uses <other>` lets an App mint sign-in tokens for
the other App and reach it on its own origin: `/_kortix/apps/<other>/*` (its
`http` service) and `/_kortix/apps/<other>--<service>/*` (another service).
In code: `kortixBinding("<other>")` from `@kortix/sdk`. A service with
`access: admins` is never bound. Details: references/bindings.md. Sign-in:
references/sign-in.md.

Every machine knows where its App answers: `KORTIX_APP_URL`,
`KORTIX_SERVICE_URL_<NAME>`, `KORTIX_APP_SLUG`, `KORTIX_MACHINE_ID`,
`KORTIX_PROCESS_GROUP`, and where each App it `uses` answers:
`KORTIX_USES_URL_<SLUG>` (a server calls a used App there; bindings.md).

## Internal apps: a backend App + a static UI

An internal app is a Convex backend App for data and logic plus a static App
for the UI. Kortix signs the team in: the UI knows who is looking, and every
function knows who is calling.

```text
member's browser ──▶ App "crm" (static UI, access: project)
      │                 └─ /_kortix/token?audience=backend  ──▶ token naming the member + groups
      └──── /_kortix/apps/backend (HTTP + websocket) ──▶ App "backend" (Convex, volume) ── requireKortixMember
```

### Layout (project repo)

```text
apps/backend/                  # Convex functions for App "backend" (references/convex.md)
  package.json                 # "convex", "@kortix/sdk"
  convex/schema.ts
  convex/auth.config.ts        # Kortix sign-in (references/sign-in.md)
  convex/lib/auth.ts           # requireMember()
  convex/<domain>.ts           # queries + mutations per domain
  convex/seed.ts               # internal seed, demo data only
  dashboard/Dockerfile         # App "backend-dashboard": Convex's dashboard (written by launch)
  dashboard/start.js           # signs the dashboard in with BACKEND_ADMIN_KEY
apps/crm/                      # static App "crm"
  package.json                 # vite, react, convex, @kortix/sdk
  src/convex.ts                # kortixBinding("backend") + ConvexReactClient
memory/crm.md                  # what you built, URLs, how to redeploy
kortix.yaml                    # apps.backend and apps.backend-dashboard (the template), apps.crm (uses: [backend])
.gitignore                     # **/node_modules and apps/*/dist: never commit them
```

Every session downloads the whole repository, so keep it small. Create
`.gitignore` before the first `npm install`.

### Build it, in this order

1. **Model the domain.** Tables, fields, relations, and the 5–10 actions
   people take. Write it down in `memory/<app>.md` first.
2. **Backend App.** `kortix apps launch --template convex`, then
   connect, discover and push as references/convex.md shows (`launch` writes
   the admin key to the project secret `BACKEND_ADMIN_KEY` and the dashboard's
   files to `apps/backend/dashboard/`; the dashboard is the Dashboard tab of `backend`).
3. **Schema + sign-in.** `convex/schema.ts` with an index for every filter,
   `convex/auth.config.ts` and `convex/lib/auth.ts` from references/sign-in.md.
   Store `me.userId` as owner/author ids. Use Kortix roles
   (`{ roles: ["owner", "admin"] }`) or groups (Enterprise only; without it
   the `groups` claim is empty, so use roles). Do not build a user table.
4. **Functions.** Every public query and mutation calls `requireMember(ctx)`
   first. Multi-row changes go in one mutation. Add an `internal` seed.
5. **Test the data layer** (references/convex.md, step 5): anonymous calls
   fail; calls with an identity succeed.
6. **UI.** Vite + React + TypeScript, `npm install convex @kortix/sdk`. Wire
   `src/convex.ts` as references/sign-in.md, "The browser", shows. Read the
   signed-in member with a `members:me` query, never `useConvexAuth()`.
   Components, theme and an embedded Kortix session thread come from
   `@kortix/ui`: `kortix system-skills file kortix-ui references/custom-dashboard.md`.
7. **Quality bar.** A product, not a demo: navigation and create/edit/delete
   for every entity with confirmation before destructive actions; loading,
   empty and error states; the signed-in name visible; realtime by default;
   a `<label>` for every input and an `aria-label` for every icon button;
   every drag-and-drop action also has a click path; responsive at 1280 px.
8. **Build, deploy and link the UI.**
   ```sh
   (cd apps/crm && npm run build)
   kortix apps deploy ./apps/crm/dist --slug crm --name "CRM" --type static --spa --access project
   kortix apps link crm --uses backend
   ```
   Never `public` for internal data: a public App has no signed-in member.
9. **Integrations** only through Kortix connectors (references/connectors.md).
10. **Ship** once Verify passed: commit, push the session branch, open a
    change request (kortix-system, `<change-requests>`). Never merge your own CR.

### Redeploy after a change, and undo

Take `kortix apps volumes snapshot backend data` before a risky change (a schema
migration, a bulk import, a backfill). Keep each data-layer change compatible
with the live UI: add before you remove.

| What broke | Undo |
| --- | --- |
| The UI | `kortix apps rollback crm <vN>` (a new release from vN) |
| The backend's image or config | `kortix apps rollback backend <vN>`: the volume keeps its data |
| Convex code | `git checkout <good-sha> -- apps/backend/convex`, push it again (references/convex.md), commit |
| Data | `kortix apps volumes restore backend data <snapshot>`, only with the user's consent: it drops every later change |

## Verify before you report (mandatory)

Report nothing as done until each check passed. Paste the evidence.

1. **Every App:** `kortix apps show <slug> --json`; fetch `app.url`
   (references/web-static.md, Verify). A server App also runs
   references/web-server.md, Verify: `kortix apps machines <slug>` shows every
   machine `started`.
2. **A backend App:** an anonymous call fails; the same call with an identity
   succeeds; a call with `kortix apps token` answers `"status":"success"`
   (references/convex.md, step 5).
3. **The deployed UI as a member:** `kortix apps access-link <app> --json` →
   open `access_session.url` with `agent-browser` (`agent-browser skills get
   core`). Drive the main flow: create, edit, move or close, delete. Assert
   the visible result after each step and that the signed-in name appears.
4. **Realtime:** a second `agent-browser` session on a fresh access link sees
   a change from the first without a reload.
5. **Report** the App URLs, the CR link, the flows you ran, and anything you
   could not verify.

## Cost

- A static App costs nothing.
- Apps have no monthly budget. Account credits pay for compute; the account
  billing gate (`402`, for example `app_account_unfunded`) is the only gate.
- An on-demand machine bills only while awake. An always-on machine bills 24/7,
  with or without traffic.
- `--budget` and `monthly_budget_usd` are retired and ignored.

Tell the user how each App runs (24/7 or on demand) before you hand over. Never
quote a price.

## Delete

```bash
kortix apps delete <slug> --yes                         # the App, its machines and images; volumes keep a final snapshot 7 days
kortix apps delete <slug> --deployment <vN> --yes       # one release (not the live one)
kortix apps volumes destroy <slug> <volume> --yes       # admins; a final snapshot is kept 7 days
```

## References

- references/apps-model.md — releases, machines, volumes, strategies, release_command, checks, scale, services, exec, the env every machine gets.
- references/web-static.md — static sources, build rules, caching, verify.
- references/web-server.md — Dockerfile and OCI Apps, process groups, run mode, wake, diagnose.
- references/convex.md — the Convex template: launch, connect, push, test, dashboard, durability, delete.
- references/convex-patterns.md — schema, queries, mutations, actions, HTTP actions, crons, files, search.
- references/sign-in.md — tokens, `kortixToken`, `verifyKortixToken`, `requireKortixMember`, troubleshooting.
- references/bindings.md — `uses` links and the `/_kortix/apps/<slug>` mount.
- references/connectors.md — calling connectors from an App.
- kortix-ui skill, references/custom-dashboard.md — a dashboard or App UI on `@kortix/sdk` + `@kortix/ui`: projects, sessions, the embedded session thread, a custom tool row, a company theme.
