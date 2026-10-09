---
name: kortix-apps
description: "Build, deploy and operate Kortix Apps through the pre-authenticated CLI or SDK: static sites and SPAs, Dockerfile or OCI servers, and `convex` Apps (self-hosted Convex: database, server functions, realtime queries, file storage, crons, search) with built-in Kortix sign-in. Use when the user asks to publish, host, deploy, preview, inspect, wake, suspend, roll back, debug, or remove an App; asks for a database, an API, a backend, a data model, auth, or 'store this'; asks for an internal tool, business app, CRM, tracker, dashboard, portal, or any app the team logs in to; before writing any Convex code; or asks what an App costs or how it runs."
---

# Kortix Apps

A Kortix App is one project-scoped thing with a stable URL, an access policy,
a size and a monthly budget. Every App has one `kind`, fixed at create:

| Kind | What it is | Capabilities |
| --- | --- | --- |
| `web`, static | Files Kortix serves itself: no machine, no cold start, no compute bill. | `deployments`, `rollback`, `preview`, `member_tokens`, `static` |
| `web`, server | A Dockerfile or OCI image in its own machine, always on or on demand. | `deployments`, `rollback`, `preview`, `member_tokens`, `sleep` |
| `convex` | A self-hosted Convex backend in its own always-on machine: data, server functions, realtime, files, crons, search. | `deployments`, `snapshots`, `restore`, `admin_credentials`, `dashboard`, `logs`, `member_tokens` |

`app.capabilities` in every App response is the only thing to branch on. A
command that needs a capability the App lacks answers
`409 app_capability_unsupported` (for example `kortix apps stop` on a
`convex` App, or `kortix apps snapshot` on a web App).

Kortix chooses and operates the provider. Never select Cloudflare, Vercel, or
another host for an App. Omit `--provider` unless an operator asks for one.

## Preflight

1. Run `pwd` and inspect the intended source directory before deploying.
2. Run `kortix projects info --json` to confirm the selected project. Read its
   identifier from `project_id`.
3. If `experimental.apps` is not `true`, Apps is off. **Do not stop.** Build
   what the user asked for with the project's own storage and code, and tell
   the user once that Kortix enables Apps per project on request. Do not
   repeat it, and do not wait for an answer.
4. A `convex` App needs Platinum machines. Where Kortix runs none, a create
   answers `409 app_kind_unavailable`. Then build without it and say so once.
5. Do not create an empty web App identity first. `kortix apps deploy`
   creates it when `--app` is omitted.
6. Never run `kortix apps deploy` from an uninspected workspace root. It can
   publish unrelated files as a static App.
7. New Apps are private. Choose another access mode only when the user asks.

## Choose what to build

| The user wants | Build | Reference |
| --- | --- | --- |
| A website or UI with no stored data | One static App | references/web-static.md |
| An app with data, login or realtime (an internal tool, a CRM, a tracker) | A `convex` App for data and logic + a static App for the UI that uses it | "Internal apps" below, references/convex.md |
| A database or an API only | A `convex` App | references/convex.md |
| A process that must run its own server (SSR, native packages, a custom service) | A server App | references/web-server.md |
| A call to an external system from an App | The connector gateway | references/connectors.md |

Default to static for every UI. Every piece of server logic for a UI —
queries, writes, webhooks, integrations, schedules — lives in a `convex` App,
not in a server App.

## Deploy

```bash
kortix apps deploy ./dist --slug storefront --name Storefront --type static --spa
kortix apps create db --kind convex && kortix apps deploy apps/db --app db
kortix apps deploy . --slug api --type dockerfile --on-demand \
  --command '["node","server.js"]' --port 3000 --readiness-path /health
```

The command waits for `ready` for up to 1200 seconds. Use `--no-wait` only
when another process owns status tracking. Use `--app <slug>` for every later
version of the same App. Never create a new slug for a normal update.

For a repeatable setup, declare the Apps in `kortix.yaml` (kortix-system,
`references/kortix/kortix-yaml.md`). `kortix apps deploy` with no arguments
deploys every block, used Apps first.

## Access

```bash
kortix apps access <app>
kortix apps access <app> --mode private
kortix apps access <app> --mode project
kortix apps access <app> --mode restricted --members <member-id> --groups <group-id>
kortix apps access <app> --mode password --password '<value>'
kortix apps access <app> --mode public
```

- `private` allows only the App creator. It is the default.
- `project` allows every current project reader.
- `restricted` allows selected project members and groups.
- `password` allows anyone who knows the App password.
- `public` requires no authentication.

For a `convex` App the mode decides who may administer it. Its endpoint is
public; its functions enforce sign-in (references/sign-in.md).

Use the equivalent `--access`, `--members`, `--groups`, and `--password`
flags on the first deploy when the user requested non-default access. Never
write a password into `kortix.yaml`, source, logs, or a command shown to
another user. Kortix stores only an Argon2id hash. A policy update revokes
existing App browser sessions.

Create a short-lived authenticated browser link without changing the policy:

```bash
kortix apps access-link <app> --json
```

Read the signed URL and expiry from `access_session.url` and
`access_session.expires_at`. It is valid for five minutes. Treat it as a
password: do not publish, commit, or log it. The first request exchanges it
for an eight-hour App-host cookie.

## Acting as the viewer

An App that calls the Kortix API for each person who opens it (a chat, a
per-user dashboard) must act as that person, never as one shared key.

```bash
kortix apps access <app> --viewer api
```

- `--viewer identity` (default) signs the viewer's id, email, and groups into
  every request (`x-kortix-app-viewer`). `--viewer api` also sends a one-hour
  token that acts as them (`x-kortix-app-viewer-token`). `--viewer off` sends
  neither.
- On the App's server, build one client per request:
  `createAppViewerKortix(request, { backendUrl })` from `@kortix/sdk/server`.
- In the browser, call the API through the gate on the App's own origin:
  `createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken() })`
  from `@kortix/sdk`. Never use `https://api.kortix.com/v1` from the browser:
  the API refuses an App origin's CORS preflight. The gate path needs
  `--viewer api` and answers `403 viewer_api_disabled` without it.
- Never give the App a personal PAT or API key to run every viewer's
  sessions: Kortix records each session as the credential's owner.
- The token holds the viewer's own role. On a project with agent permissions,
  grant viewers the agent the App starts, or session creation answers
  `403 no_agent_access`.
- Never log the viewer headers.

## Apps that use other Apps

`kortix apps link <app> --uses <other>` lets an App get sign-in tokens for
the other App and reach it through `/_kortix/apps/<other>/*` on its own
origin. In code: `kortixBinding("<other>")` from `@kortix/sdk` gives the URL
and a token fetcher. A new App uses none: any other audience answers
`403 app_not_linked`. Details: references/bindings.md. Sign-in for every
kind: references/sign-in.md.

## Internal apps: a `convex` App + a static UI

An internal app is a `convex` App for data and logic plus a static App for
the UI. Kortix signs the team in: the UI knows who is looking, and every
function knows who is calling. You ship both from the project repo, and you
verify the deployed app yourself before you report.

```text
member's browser ──▶ App "crm" (static UI, access: project)
      │                 └─ /_kortix/token?audience=db  ──▶ token naming the member + groups
      └──── /_kortix/apps/db (HTTP + websocket) ──▶ App "db" (convex)  ── requireKortixMember
```

### Layout (project repo)

```text
apps/db/                       # convex App "db" (references/convex.md)
  package.json                 # "convex", "@kortix/sdk"
  convex/schema.ts
  convex/auth.config.ts        # Kortix sign-in (references/sign-in.md)
  convex/lib/auth.ts           # requireMember()
  convex/<domain>.ts           # queries + mutations per domain
  convex/seed.ts               # internal seed, demo data only
apps/crm/                      # static App "crm"
  package.json                 # vite, react, convex, @kortix/sdk
  src/convex.ts                # kortixBinding("db") + ConvexReactClient
memory/crm.md                  # what you built, URLs, how to redeploy
kortix.yaml                    # apps.db (kind: convex), apps.crm (uses: [db])
.gitignore                     # **/node_modules and apps/*/dist: never commit them
```

Every session downloads the whole repository, so keep it small. Create
`.gitignore` before the first `npm install`.

### Build it, in this order

1. **Model the domain.** Turn the request into tables, fields, relations and
   the 5–10 actions people take. Write it down in `memory/<app>.md` first.
2. **`convex` App scaffold.** Steps 1 and 2 of the six-step loop in
   references/convex.md (install, connect). Read
   `convex/_generated/ai/guidelines.md`.
3. **Schema + sign-in.** `convex/schema.ts` with indexes for every filter,
   `convex/auth.config.ts` and `convex/lib/auth.ts` from
   references/sign-in.md. Store `me.userId` as owner/author ids. Use Kortix
   roles (`{ roles: ["owner", "admin"] }`) or groups
   (`{ groups: ["Finance"] }`) for who may do what. Groups need the Enterprise
   plan: without it the `groups` claim is empty and a group rule refuses
   everyone, so use roles. Do not build a user or role table the team already
   has in Kortix.
4. **Functions.** Every public query and mutation calls `requireMember(ctx)`
   first. Put multi-row changes (move a card, close a deal) in one mutation so
   they are atomic. Add an `internal` seed.
5. **Deploy and test the data layer.**
   ```sh
   kortix apps deploy apps/db --app db
   eval "$(kortix apps credentials db)" && cd apps/db
   npx convex run seed:run
   npx convex run <domain>:list '{}'     # must FAIL: no identity
   ISS=$(npx convex env get KORTIX_AUTH_ISSUER)
   npx convex run --identity "{\"subject\":\"test-user\",\"issuer\":\"$ISS\",\"name\":\"Test\"}" <domain>:create '{…}'
   ```
6. **UI.** Vite + React + TypeScript
   (`npm create vite@latest apps/crm -- --template react-ts`),
   `npm install convex @kortix/sdk`. Wire `src/convex.ts` exactly as
   references/sign-in.md, "The browser", shows and wrap the app in
   `ConvexProvider`. Import the API types from `apps/db/convex/_generated/api`
   with a relative path.
7. **Quality bar.** It must feel like a product, not a demo:
   - navigation for every entity; create, edit, delete for each; confirmation
     before destructive actions;
   - loading, empty and error states for every list;
   - the signed-in member's name visible; author/assignee shown where it
     matters; "mine" filters where people expect them;
   - realtime by default (`useQuery` re-renders on change), no reload buttons;
   - every input has a `<label>`, every icon button an `aria-label`, so people
     and test agents can drive it;
   - every drag-and-drop action also has a click path: `agent-browser drag`
     does not fire native HTML5 drag events;
   - responsive down to a laptop at 1280 px; consistent spacing and type.
8. **Build, deploy and link the UI.**
   ```sh
   (cd apps/crm && npm run build)
   kortix apps deploy ./apps/crm/dist --slug crm --name "CRM" --type static --spa --access project
   kortix apps link crm --uses db       # the UI gets tokens and the binding only for Apps it uses
   ```
   `--access project` lets every project member in. Use `restricted` with
   `--members/--groups` for a smaller audience. Never `public` for internal
   data: a public App has no signed-in member, so sign-in fails by design.
9. **Integrations** (only when the app calls other systems): from a `convex`
   App action through Kortix connectors, never with a raw API key
   (references/connectors.md). The service account it needs is a human step:
   ask for it, and build everything else meanwhile.
10. **Ship**, once every check in Verify below passed. Commit both Apps,
    `kortix.yaml` and `memory/<app>.md`, push the session branch, and open a
    change request (kortix-system, `<change-requests>`). Never merge your own
    CR.

### Redeploy after a change

Take `kortix apps snapshot db` before a risky change (a schema migration, a
bulk import, a destructive backfill). A schema change that existing rows
violate fails the deploy: add new fields as `v.optional(...)` and backfill
(references/convex-patterns.md). Keep every data-layer change compatible with
the UI build that is live now: add before you remove. Then each half rolls
back alone:

| What broke | Undo |
| --- | --- |
| The UI | `kortix apps rollback crm <deployment-id>` (ids in `kortix apps show crm --json`) |
| Convex code | `git checkout <good-sha> -- apps/db/convex`, then `kortix apps deploy apps/db --app db`, then commit |
| Data | `kortix apps restore db <snapshot-id> --yes`, only with the user's consent: it drops every later change |

## Verify before you report (mandatory)

Do not stop at a `ready` status. Report nothing as done until each check
passed. Paste the evidence.

1. **Every App:** `kortix apps show <slug> --json`. Fetch `app.url` as
   references/web-static.md, Verify, describes. A server App also runs
   references/web-server.md, Verify.
2. **A `convex` App:** an anonymous `npx convex run <domain>:list` fails; the
   same call with `--identity` succeeds; a call with `kortix apps token`
   answers `"status":"success"` (references/convex.md, step 5).
3. **The deployed UI as a member:**
   ```sh
   kortix apps access-link <app> --json      # → access_session.url (5 min)
   ```
   `agent-browser` is installed in the sandbox: load its guide with
   `agent-browser skills get core`. Open `access_session.url` with it. Drive
   the main flow through the UI: create, edit, move or close, delete. Assert
   the visible result after each step, and that the signed-in name appears.
4. **Realtime:** open a second `agent-browser` session on a fresh access
   link, change something in the first, and assert the second shows it
   without a reload.
5. **Report** the App URL, the CR link, the flows you ran, and anything you
   could not verify. If the App URL does not resolve from your sandbox, say
   so and give the user the flows to click.

Only when the user asks to see an App inside Kortix: open
`/projects/<project-id>/apps` in a signed-in browser. A web App shows its
live preview; a `convex` App shows its dashboard. Assert DOM and network
data, not a screenshot alone.

## Cost

- A static App costs nothing.
- A server App bills its machine while it runs; a new always-on App gets its
  24/7 estimate as its monthly budget and stops at it (references/web-server.md).
- A `convex` App is always on, about $59 a month at the default size. Its
  budget alerts at 80 % and 100 % and never stops it (references/convex.md).

Tell the user the cost of each App before you hand over.

## Delete

```bash
kortix apps delete <slug> --yes                         # a web App
kortix apps delete <slug> --deployment <id|vN> --yes    # one web deployment (not the live one)
kortix apps delete <slug> --confirm <slug>              # an App with snapshots (convex): the typed slug
```

A web App delete removes the identity, its runtimes and every image it built.
A `convex` App delete takes a `final` snapshot, keeps the stopped machine 7
days, then deletes every document and file (references/convex.md, Delete).

## References

- references/web-static.md — static sources, build rules, caching, verify.
- references/web-server.md — Dockerfile and OCI Apps, run mode, budget, wake, diagnose.
- references/convex.md — `convex` Apps: the six-step loop, commands, durability, backups, cost, delete.
- references/convex-patterns.md — schema, queries, mutations, actions, HTTP actions, crons, files, search.
- references/sign-in.md — tokens, `kortixToken`, `verifyKortixToken`, `requireKortixMember`, troubleshooting, customers.
- references/bindings.md — `uses` links and the `/_kortix/apps/<slug>` mount.
- references/connectors.md — calling connectors from an App.
