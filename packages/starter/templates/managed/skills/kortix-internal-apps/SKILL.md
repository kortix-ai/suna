---
name: kortix-internal-apps
description: "Recipe for building and shipping a complete internal business app on Kortix: a Kortix Backend (Convex: data, server logic, realtime, Kortix sign-in) plus a Kortix App (the UI), committed to the project repo, deployed, and verified end to end. Load ONLY when the `backends` and `apps` features are on in this project (`kortix projects features` lists both as enabled) or the user names Kortix Backends. Then use it when the user asks for an internal tool, a business app, a CRM, tracker, dashboard, portal, inventory, booking, approval or ticketing system, a 'full-stack app', or any app the team will log in to and use. When either feature is off, do not load it: build the app with the project's own storage and code. Load kortix-backends and kortix-apps with it."
---

# Internal apps on Kortix

An internal app is a **Kortix Backend** for data and logic plus a **Kortix App**
for the UI. The App is frontend only: every server function — APIs, webhooks
(HTTP actions), integrations (actions), schedules — lives in the backend. Kortix signs the team in: the App knows who is looking, and every
backend function knows who is calling. You ship both from the project repo, and
you verify the deployed app yourself before you report.

```text
member's browser ──▶ Kortix App (static UI, access: project)
      │                 └─ kortixAppBackendToken()     ──▶ JWT naming the member + groups
      └──── websocket ──▶ Kortix Backend (Convex)  ── requireKortixMember(identity)
```

## Prerequisites

Both `apps` and `backends` must be on. Check either way:

- `kortix projects features` lists `apps on kortix` and `backends on kortix`.
  An internal-only flag that is off is not listed at all.
- `kortix projects info --json` has `experimental.apps` and
  `experimental.backends` both `true`.

Kortix enables each one per project. You cannot change them:
`kortix projects features enable` answers `feature_operator_only`.

**When either is off, do not stop and do not use this recipe.** Build the app
the user asked for with what the project has: the project's own storage and
code, and a Kortix App per kortix-apps when `apps` is on. Tell the user once
that Kortix can enable the missing feature (name it) for a managed backend
with Kortix sign-in. Do not repeat it, and do not wait for an answer before
you build. Never call a `kortix backends` command or write Convex code for a
Kortix backend while `backends` is off.

## Layout (project repo)

```text
backends/main/                 # Kortix Backend "main" (kortix-backends)
  package.json                 # "convex"
  convex/schema.ts
  convex/auth.config.ts        # Kortix sign-in (copy from kortix-backends)
  convex/lib/auth.ts           # requireMember()
  convex/<domain>.ts           # queries + mutations per domain
  convex/seed.ts               # internal seed, demo data only
apps/<app>/                    # Kortix App (kortix-apps)
  package.json                 # vite, react, convex
  .env.production              # VITE_CONVEX_URL=<backend url> (public)
  src/convex.ts                # ConvexReactClient + setAuth
memory/<app>.md                # what you built, URLs, how to redeploy
.gitignore                     # **/node_modules and apps/*/dist: never commit them
```

Every session downloads the whole repository, so keep it small (kortix-system, `<gotchas>`).
Create `.gitignore` before the first `npm install`.

## Build it, in this order

1. **Model the domain.** Turn the request into tables, fields, relations and
   the 5–10 actions people take. Write it down in `memory/<app>.md` first.
2. **Backend scaffold.** Steps 1 and 2 of the six-step loop in
   kortix-backends (install, connect). Read
   `convex/_generated/ai/guidelines.md`.
3. **Schema + sign-in.** `convex/schema.ts` with indexes for every filter,
   `convex/auth.config.ts` and `convex/lib/auth.ts` from kortix-backends
   (references/sign-in.md), built on `requireKortixMember` from `@kortix/sdk`
   (`npm i @kortix/sdk` in the backend and the App). If the installed SDK
   does not export it yet, use the fallback in sign-in.md, "SDK version".
   Store `me.userId` as owner/author ids. Use Kortix roles
   (`{ roles: ["owner", "admin"] }`) or Kortix groups (`{ groups: ["Finance"] }`)
   for who may do what. Groups need the Enterprise plan: without it the
   `groups` claim is empty and a group rule refuses everyone, so use roles.
   Do not build a user or role table the team already has in Kortix.
4. **Functions.** Every public query and mutation calls `requireMember(ctx)`
   (or `requireMember(ctx, { groups: [...] })`) first. Put multi-row changes (move a card, close a deal) in one mutation so
   they are atomic. Add an `internal` seed.
5. **Deploy and test the backend.** `--create` creates `main` on the first
   deploy; later deploys omit it, so a mistyped name fails instead of starting
   a second machine.
   ```sh
   kortix backends deploy main --dir backends/main --create
   eval "$(kortix backends env main)" && cd backends/main
   npx convex run seed:run
   npx convex run <domain>:list '{}'     # must FAIL: no identity
   ISS=$(npx convex env get KORTIX_AUTH_ISSUER)
   npx convex run --identity "{\"subject\":\"test-user\",\"issuer\":\"$ISS\",\"name\":\"Test\"}" <domain>:create '{…}'
   ```
6. **UI.** Vite + React + TypeScript (`npm create vite@latest apps/<app> -- --template react-ts`),
   `npm install convex`. Wire `src/convex.ts` exactly as kortix-backends
   references/sign-in.md shows and wrap the app in `ConvexProvider`. Import the
   API types from `backends/main/convex/_generated/api` with a relative path
   (count the levels from the importing file). Package managers now block
   install scripts by default and Vite then fails on esbuild: with npm 12 run
   `npm install-scripts approve esbuild` in each package directory (it records
   `allowScripts` in `package.json`); with pnpm 11 add `allowBuilds:
   { esbuild: true }` to `pnpm-workspace.yaml`.
7. **Quality bar.** It must feel like a product, not a demo:
   - navigation for every entity; create, edit, delete for each; confirmation
     before destructive actions;
   - loading, empty and error states for every list;
   - the signed-in member's name visible; author/assignee shown where it
     matters; "mine" filters where people expect them;
   - realtime by default (`useQuery` re-renders on change), no reload buttons;
   - every input has a `<label>`, every icon button an `aria-label`, so people
     and test agents can drive it;
   - every drag-and-drop action also has a click path (a status menu or
     buttons): `agent-browser drag` does not fire native HTML5 drag events;
   - responsive down to a laptop at 1280 px; consistent spacing and type.
8. **Build and deploy the App.**
   ```sh
   cd apps/<app>
   printf 'VITE_CONVEX_URL=%s\n' "$(kortix backends get main --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["backend"]["url"])')" > .env.production
   npm run build
   cd - && kortix apps deploy ./apps/<app>/dist --slug <app> --name "<Name>" --type static --spa --access project
   kortix apps set <app> --backends main     # the App gets sign-in tokens only for the backends it lists
   ```
   `--access project` lets every project member in. Use `restricted` with
   `--members/--groups` for a smaller audience. Never `public` for internal
   data: a public App has no signed-in member, so sign-in fails by design.
9. **Integrations** (only when the app calls other systems: a CRM sync, a
   Slack notice on approval). Call them from a backend action through Kortix
   connectors, never with a raw API key: kortix-backends, "Call Kortix and
   connectors from the backend". The service account it needs is a human
   step: ask for it, and build everything else meanwhile.
10. **Ship**, once every check in Verify below passed. Commit the backend, the App and `memory/<app>.md`, push the
    session branch, and open a change request (kortix-system,
    `<change-requests>`):
    ```sh
    git add backends apps memory .gitignore && git commit -m "feat: <app>"
    git push origin HEAD
    kortix cr open --title "<App name>: internal app" --description "Backend main + App <app>. URL: <app url>"
    ```
    The deployed App runs from your session's build; the CR is how the code
    reaches `main` so the next session can change it. Never merge your own CR.

## Verify before you report (mandatory)

Report nothing as done until each check passed. Paste the evidence.

1. **Backend rules:** an anonymous `npx convex run <domain>:list` fails; the
   same call with `--identity` succeeds.
2. **The deployed App as a member:**
   ```sh
   kortix apps access-link <app> --json      # → access_session.url (5 min)
   ```
   `agent-browser` is installed in the sandbox: load its guide with
   `agent-browser skills get core`. Open `access_session.url` with it. Drive the
   main flow through the UI: create, edit, move or close, delete. Assert the
   visible result after each step, and that the signed-in name appears.
3. **Realtime:** open a second `agent-browser` session on a fresh access link,
   change something in the first, and assert the second shows it without a
   reload.
4. **Report** the App URL (`kortix apps show <app> --json` → `url`), the CR
   link, the flows you ran, and anything you could not verify. If the App URL
   does not resolve from your sandbox, say so in the report and give the user
   the flows to click.

## Redeploy after a change

Before a risky change (a schema migration, a bulk import, a destructive
backfill) take a snapshot: `kortix backends snapshot main`. If it goes wrong,
`kortix backends restore main <snapshot-id> --yes` (after the user agrees). If
the app gets slow under real use, `kortix backends resize main --cpu 2 --memory 4`.

```sh
kortix backends deploy main --dir backends/main                     # backend code
cd apps/<app> && npm run build && cd - && kortix apps deploy ./apps/<app>/dist --app <app> --type static --spa
```

A schema change that existing rows violate fails the deploy: add new fields as
`v.optional(...)` and backfill (kortix-backends references/convex-patterns.md).

## Operate

**Cost.** The backend is one always-on machine, billed like a sandbox:
reserved CPU, memory and disk × wall-clock time, about $59 for a 30-day month
at the default size (kortix-backends, "Cost and limits"). The App's cost is
in kortix-apps. Tell the user both before you hand over.

**Rollback.** Keep every backend change compatible with the App build that
is live now: add before you remove (a new optional field, then the UI that
uses it, then the cleanup). Then each half rolls back alone:

| What broke | Undo |
| --- | --- |
| The UI | `kortix apps rollback <app> <deployment-id>` (ids in `kortix apps show <app> --json`) |
| Backend code | `git checkout <good-sha> -- backends/main/convex`, then `kortix backends deploy main --dir backends/main`, then commit |
| Data | `kortix backends restore main <snapshot-id> --yes`, only with the user's consent: it drops every later change |

**Observe.**

| Question | Command |
| --- | --- |
| Did the App deploy? | `kortix apps show <app> --json` (deployments and their events) |
| Do functions fail? | `timeout 20 npx convex logs --history 100` |
| Does Convex crash or restart? | `kortix backends logs main --lines 200`, `kortix backends get main` (health) |
| Does sign-in fail? | kortix-backends references/sign-in.md, "Troubleshoot sign-in" |
| What does the data look like? | `kortix backends dashboard main` |

**An agent calls the App's API.** This applies only to an App with its own
server API (a Dockerfile App). A backend-only internal app does not need it:
an agent uses `npx convex run` or `kortix backends token`. Register the App's
API as a project connector whose base URL is the App URL (kortix-connectors,
`<adding-connectors>`), and call it with `kortix connectors call`. For an App
of the same project on `https`, the connector gateway adds a 60-second App
assertion. The App gate verifies it, resolves it to the session's own token,
and applies the App's access policy to that session. Neither the agent nor
the App handles a Kortix credential. Never paste a personal token into the App
instead.
