---
name: kortix-internal-apps
description: "Recipe for building and shipping a complete internal business app on Kortix: a Kortix Backend (Convex: data, server logic, realtime, Kortix sign-in) plus a Kortix App (the UI), committed to the project repo, deployed, and verified end to end. Use when the user asks for an internal tool, a business app, a CRM, tracker, dashboard, portal, inventory, booking, approval or ticketing system, a 'full-stack app', or any app the team will log in to and use. Load kortix-backends and kortix-apps with it."
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

`kortix projects features` must show `apps` and `backends` enabled. If either
is off, stop and tell the user to contact Kortix to enable it for the project
(neither is listed in Settings).
Do not work around a disabled feature.

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
```

## Build it, in this order

1. **Model the domain.** Turn the request into tables, fields, relations and
   the 5–10 actions people take. Write it down in `memory/<app>.md` first.
2. **Backend scaffold.** `mkdir -p backends/main && cd backends/main && npm init -y && npm install convex && npx convex ai-files install`.
   Read `convex/_generated/ai/guidelines.md`.
3. **Schema + sign-in.** `convex/schema.ts` with indexes for every filter,
   `convex/auth.config.ts` and `convex/lib/auth.ts` from kortix-backends
   (references/sign-in.md), built on `requireKortixMember` from `@kortix/sdk`
   (`npm i @kortix/sdk` in the backend and the App). Store `me.userId` as
   owner/author ids. Use Kortix groups (`{ groups: ["Finance"] }`) or roles
   (`{ roles: ["owner", "admin"] }`) for who may do what; do not build a user
   or role table the team already has in Kortix.
4. **Functions.** Every public query and mutation calls `requireMember(ctx)`
   (or `requireMember(ctx, { groups: [...] })`) first. Put multi-row changes (move a card, close a deal) in one mutation so
   they are atomic. Add an `internal` seed.
5. **Deploy and test the backend.**
   ```sh
   kortix backends deploy main --dir backends/main
   eval "$(kortix backends env main)" && cd backends/main
   npx convex run seed:run
   npx convex run <domain>:list '{}'     # must FAIL: no identity
   npx convex run --identity '{"subject":"test-user","email":"test@example.com","name":"Test"}' <domain>:create '{…}'
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
   ```
   `--access project` lets every project member in. Use `restricted` with
   `--members/--groups` for a smaller audience. Never `public` for internal
   data: a public App has no signed-in member, so sign-in fails by design.
9. **Commit** backend, App, `memory/<app>.md` on the session branch.

## Verify before you report (mandatory)

Report nothing as done until each check passed. Paste the evidence.

1. **Backend rules:** an anonymous `npx convex run <domain>:list` fails; the
   same call with `--identity` succeeds.
2. **The deployed App as a member:**
   ```sh
   kortix apps access-link <app> --json      # → access_session.url (5 min)
   ```
   Open `access_session.url` with `agent-browser` (load its skill). Drive the
   main flow through the UI: create, edit, move or close, delete. Assert the
   visible result after each step, and that the signed-in name appears.
3. **Realtime:** open a second `agent-browser` session on a fresh access link,
   change something in the first, and assert the second shows it without a
   reload.
4. **Report** the App URL (`kortix apps show <app> --json` → `url`), the flows you ran,
   and anything you could not verify.

If the App hostname does not resolve from your sandbox (a developer's local
Kortix stack serves Apps on `*.apps.localhost`), serve the built `dist/` from a
tiny local server that answers `GET /_kortix/backend-token` with
`kortix backends token <name> --json`, and run steps 2–3 against it: that is the
same build, backend, Kortix token and realtime path. Say in the report that you
verified this way, and give the user the App URL and the flows to click.

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
