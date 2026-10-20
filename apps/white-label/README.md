# White label on Kortix

Two reference apps for building your own product on Kortix. Both are thin consumers of
[`@kortix/sdk`](../../packages/sdk/README.md) and [`@kortix/ui`](../../packages/ui/README.md).
Pick the one that matches who signs in.

| | [Team Console](team-console/README.md): an internal tool | [Lumen](lumen/README.md): a SaaS you sell |
|---|---|---|
| Who signs in | Your own team. Everyone already has a Kortix login. | The partner's customers. They never see Kortix. |
| Identity | The Kortix App viewer identity (`kortixAppViewerToken`) | Lumen's own auth (Better Auth + organizations) |
| Data | Kortix is the data: projects, sessions | Lumen's own Convex database. Kortix ids are foreign keys on Lumen rows. |
| Agents | The project's agents | Lumen's own agent kit (agents, skills, a tool CLI), installed into each customer's project, plus Lumen's own orchestration engine |
| Hosting | `kortix apps deploy dist --type static --spa` | The partner's own hosting (Next.js + Convex) |
| Credential | Viewer token, inside the App | Server-held operator token. Members get a 1 h project-scoped token behind a same-origin proxy. |
| Billing | Kortix bills the account | The partner bills its customers (Stripe). Kortix bills the partner. |
| Pick it when | A team wants its own console over its own Kortix work | You sell a product with your brand, users, plans and data |

## Lumen: AI for legal teams, sold to law firms

A complete legal-AI SaaS in its own brand: a public site, sign-up and onboarding, firms with roles
and seats, matters, a document vault with search, an Assistant whose every citation Lumen checks
against the source, review tables, contract review against a playbook with a tracked-changes
redline, due diligence, drafting, history, usage, billing and an audit log. Each firm is one
Kortix project; Lumen installs its own agents, skills and tools there and runs multi-step work
over Kortix sessions from its own Convex engine.

<p align="center"><img src="lumen/public/screenshots/tour.gif" width="860" alt="Lumen in 15 seconds: a matter, a vault search, a cited answer, a review cell, a contract review" /></p>

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
Lumen (Convex)                     Kortix
───────────────                    ──────
firms.kortixProjectId      ──────▶ project      (provisioned with idempotency_key = lumen-firm-<firmId>)
matters.driveFolder        ──────▶ Drive folder /Company/Lumen/Matters/<matterId>/
threads.kortixSessionId    ──────▶ session      (labels lumen-firm:<id>, lumen-matter:<id>, lumen-user:<id>)
runBatches.kortixSessionId ──────▶ session      (one per batch; label lumen-run:<id>)
firms.kitVersion           ──────▶ agents/lumen-*.md, skills/lumen-*/, lumen-kit/ on the default branch
memberTokens               ──────▶ 1 h project-scoped token, held on Lumen's server
```

Lumen URLs carry only Convex ids. Kortix ids never reach a Lumen URL.

## Run locally

- Team Console: [team-console/README.md](team-console/README.md#try-it-now)
- Lumen: [lumen/README.md](lumen/README.md#run-it)

## Rules for both

1. Every Kortix call goes through `@kortix/sdk`. No raw `fetch` to the Kortix API.
2. One client per host (`createKortix`).
3. `scripts/sdk-boundary.mjs` in each app enforces 1 and 2. `pnpm --filter <pkg> typecheck` runs it.
4. The platform stays generic: no legal (or other product) concept goes into Kortix. Lumen's
   agents, skills and tools live in its own repo folder (`lumen/agent-kit/`) and reach Kortix
   through generic SDK calls.
5. Synthetic data only: fictional parties, `@example.com` emails, no customer documents.
