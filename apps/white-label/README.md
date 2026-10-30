# White label on Kortix

Three reference apps for building your own product on Kortix. All three are thin consumers of
[`@kortix/sdk`](../../packages/sdk/README.md) and [`@kortix/ui`](../../packages/ui/README.md).
Pick the one that matches what you sell and who signs in.

| | [Lumen Workspace](reskin/README.md): a reskin | [Team Console](team-console/README.md): an internal tool | [Lumen](lumen/README.md): a SaaS you sell |
|---|---|---|---|
| What it is | The Kortix workspace (projects, sessions, Files, settings) under your theme, mark and fonts | Your team's own console over its Kortix work | Your own product with its own domain model; Kortix runs the agents |
| Who signs in | Direct mode: anyone with a Kortix API key. Wrapper mode: your app's users | Your own team. Everyone already has a Kortix login. | The partner's customers. They never see Kortix. |
| Identity | A pasted Kortix PAT (direct), or your app's own login (wrapper) | The Kortix App viewer identity (`kortixAppViewerToken`) | Lumen's own auth (Better Auth + organizations) |
| Data | Kortix is the data: projects, sessions, files | Kortix is the data: projects, sessions | Lumen's own Convex database. Kortix ids are foreign keys on Lumen rows. |
| Agents | The project's agents | The project's agents | Lumen's own agent kit (role prompts, skills, a tool CLI), installed once into Lumen's one Kortix project, plus Lumen's own orchestration engine |
| Hosting | Your own Next.js hosting | `kortix apps deploy dist --type static --spa` | The partner's own hosting (Next.js + Convex) |
| Credential | Direct: the PAT in the browser. Wrapper: `KORTIX_API_KEY` on your server, behind a same-origin proxy with a deny-by-default route policy | Viewer token, inside the App | Server-held operator token for setup. Each customer firm gets a Kortix service account; its members reach Kortix only through a same-origin proxy that holds it. |
| Billing | Kortix bills the account; wrapper mode can show costs with your markup | Kortix bills the account | The partner bills its customers (Stripe). Kortix bills the partner. |
| Pick it when | You want the full Kortix product in your brand, today, with one theme file | A team wants its own console over its own Kortix work | You sell a product with your brand, users, plans and data |

## Lumen Workspace: the Kortix workspace in your brand

The reskin pattern. Every screen is a Kortix module from `@kortix/ui` (project home, session
workspace with tool rows and the side panel, Files, settings) under a typed `KortixTheme`:
lagoon teal on warm sand, its own serif display face and its own mark. The brand is two files:
`src/config/brand.ts` (name, tagline) and `src/config/theme.ts` (colors, radius, fonts).

- **Direct mode** (default): each person pastes a Kortix API key and the browser calls the
  Kortix API. The API must allow the page's origin through CORS.
- **Wrapper mode** (`KORTIX_API_KEY` set): people sign in to your app, and a same-origin proxy
  holds the key, checks project ownership and applies a deny-by-default route policy.

<p align="center"><img src="reskin/public/screenshots/tour.gif" width="860" alt="Lumen Workspace: the project home, a prompt, tool rows and the reply streaming in, the Files panel and a file" /></p>

[Lumen Workspace README](reskin/README.md): what it does, the two modes, the brand seam and how
to run it.

## Lumen: AI for legal teams, sold to law firms

A complete legal-AI SaaS in its own brand: a public site, sign-up and onboarding, firms with roles
and seats, matters, a document vault with search, an Assistant whose every citation Lumen checks
against the source, review tables, contract review against a playbook with a tracked-changes
redline, due diligence, drafting, history, usage, billing and an audit log. One Kortix project
is Lumen's whole backend: every firm is a folder, an agent and a service account in it, and
Kortix keeps each firm's sessions and files away from every other firm. Lumen installs its own
role prompts, skills and tools there once and runs multi-step work over Kortix sessions from its
own Convex engine.

<p align="center"><img src="lumen/public/screenshots/tour.gif" width="860" alt="Lumen in 15 seconds: a matter, a vault search, a cited answer, a review cell, a contract review, a due-diligence report" /></p>

| | |
| --- | --- |
| ![A cited answer with the Source panel](lumen/public/screenshots/assistant-source.png) | ![A review table with the cell panel](lumen/public/screenshots/review-grid.png) |

[Lumen README](lumen/README.md): the product, the agent kit, the run engine, the measured eval
scores, the id mapping, the credential flow, and how to run it with or without Stripe.

## Team Console: your team's own console over Kortix

A Vite single-page app in four screens: projects, a project's sessions, a session thread, and a
cross-project dashboard. No backend, no login, no database. It deploys as a static Kortix App and
runs as the viewer.

<p align="center"><img src="team-console/public/screenshots/tour.gif" width="820" alt="Team Console: open a project, start a session, the dashboard lists it" /></p>

[Team Console README](team-console/README.md): what it does, how to deploy it, and how to run it
locally.

## Lumen's id mapping, in one picture

```
Lumen (Convex)                     Kortix: ONE project for every firm
───────────────                    ──────────────────────────────────
deployment.projectId       ──────▶ project      (KORTIX_PROJECT_ID, or idempotency_key = lumen-deployment)
deployment.kitVersion      ──────▶ Drive /Lumen/Kit/<version>/ (role prompts, skills, lumen-kit), read-only for every firm
firms._id                  ──────▶ Drive /Lumen/Firms/<firmId>/, agent lumen-f-<firmId>, service account lumen-firm-<firmId>
matters.driveFolder        ──────▶ Drive folder /Lumen/Firms/<firmId>/Matters/<matterId>/ (a restricted matter: /Lumen/Walled/<matterId>/)
matters.kortixAgent        ──────▶ agent lumen-m-<matterId>, a restricted matter's own (kortix.placeMatter)
threads.kortixSessionId    ──────▶ session      (created by the firm's service account; labels lumen-firm:, lumen-matter:, lumen-user:)
runBatches.kortixSessionId ──────▶ session      (one per batch; label lumen-run:<id>)
firmCredentials            ──────▶ the firm service account's secret, held on Lumen's server
```

A firm session mounts only its firm folder and the kit, and a firm's service account reaches only
the sessions it created. The full isolation table is in
[Lumen README → One project, many firms](lumen/README.md#one-project-many-firms).

Lumen URLs carry only Convex ids. Kortix ids never reach a Lumen URL.

## Run locally

- Lumen Workspace: [reskin/README.md](reskin/README.md#run-and-verify)
- Team Console: [team-console/README.md](team-console/README.md#try-it-now)
- Lumen: [lumen/README.md](lumen/README.md#run-it)

## Rules for all three

1. Every Kortix call goes through `@kortix/sdk`. No raw `fetch` to the Kortix API.
2. One client per host (`createKortix`).
3. `scripts/sdk-boundary.mjs` in each app enforces 1 and 2. `pnpm --filter <pkg> typecheck` runs it.
4. The platform stays generic: no legal (or other product) concept goes into Kortix. Lumen's
   agents, skills and tools live in its own repo folder (`lumen/agent-kit/`) and reach Kortix
   through generic SDK calls.
5. Synthetic data only: fictional parties, `@example.com` emails, no customer documents.
