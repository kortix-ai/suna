# Lumen: a customer-facing product built on Kortix

Lumen is the reference for an **outward-facing app**: a product with its own
users, its own organizations and its own database, that uses Kortix as the
backend for off-the-shelf agents. Lumen sells three specialists (Finance
analyst, Legal reviewer, Research). Its customers never see Kortix, never get a
Kortix account and never hold a Kortix credential.

- Stack: Next.js 16, Convex (database + server functions), Better Auth on
  Convex (email + password, organizations).
- UI: `@kortix/ui`, re-themed by tokens. The session page is the same
  `useSession` + `@kortix/ui/session` workbench every Kortix host renders.
- Kortix access: `@kortix/sdk` only. Server-side calls use
  `@kortix/sdk/server`; the browser uses the one `createKortix` client.

## When to pick this example

| You are building | Pick |
|---|---|
| An internal tool for people who already have Kortix accounts (your team, your company). Kortix is the identity and the data. | The internal example, `apps/internal-app-demo` (a static Kortix App; sign-in is Kortix's). |
| A product for your own customers, under your brand, with your own sign-up, orgs, billing and data. Kortix runs the agents behind it. | **This app.** |

## Who owns what

| Concern | Owner | Where |
|---|---|---|
| Users, passwords, sessions | Lumen | Better Auth tables in the Convex component `convex/betterAuth/` |
| Organizations, members, invitations | Lumen | Better Auth `organization` plugin |
| Workspaces, threads, templates, audit log | Lumen | `convex/schema.ts` |
| Agents, sandboxes, sessions, transcripts, files | Kortix | One Kortix project per workspace |
| The Kortix credential | Lumen's operator | `KORTIX_OPERATOR_TOKEN`, Convex env only |

Kortix sees one account: Lumen's operator account. It knows nothing about
Lumen's users or organizations except the generic labels and metadata Lumen
writes on each session (below). No Kortix API has a Lumen concept in it.

## Id mapping

Lumen stores every Kortix id next to its own id. The browser never chooses
which Kortix project a credential reaches: the server resolves it from Lumen's
ids.

| Lumen | Kortix | Stored in | Written by |
|---|---|---|---|
| organization (`organization.id`) | none | Better Auth | Better Auth |
| workspace (`workspaces._id`) | project (`project_id`) | `workspaces.kortixProjectId` | `kortix.provisionWorkspace`, idempotency key = workspace id |
| agent template (`agentTemplates.slug`) | agent (`agents/<slug>.md`, project default agent) | `workspaces.templateSlug` | `kortix.provisionWorkspace` (`updateAgentConfig`, `updateProjectDefaultAgent`) |
| thread (`threads._id`) | session (`session_id`) | `threads.kortixSessionId` | `kortix.createThread`, or the proxy for a session the session UI creates |
| member (`user._id`) | project-scoped token (`token_id`) | `memberTokens` (server-only) | `kortix.memberToken` |

Each Kortix session carries Lumen's ids as generic data, so the operator can
trace a session back from the Kortix side:

- `labels`: `lumen-user:<userId>`, `lumen-workspace:<workspaceId>`
- `metadata`: `lumen_org_id`, `lumen_workspace_id`, `lumen_user_id`

## Credential flow

```
browser ── Bearer ws.<workspaceId> + Better Auth cookie ──▶ Next.js /api/kortix/*
Next.js ── user JWT + LUMEN_PROXY_SECRET ──▶ Convex kortix.memberToken
Convex  ── membership check (Better Auth member table)
        ── reuse the stored token, or mint one with KORTIX_OPERATOR_TOKEN:
           POST /v1/accounts/tokens { project_id, expires_at: now + 1 h }
Next.js ── forwardKortixRequest(member token) ──▶ Kortix API / session runtime
```

1. The operator credential exists only in Convex env. Next.js and the browser
   never see it.
2. The browser bearer is `ws.<workspaceId>`. It is not a secret. Identity is
   the Better Auth cookie, which the SDK sends because `backendUrl` is the
   same-origin path `/api/kortix`.
3. Convex checks org membership on every token request. The Next.js proxy
   re-checks each (user, workspace) pair at least once a minute.
4. The member token is project-scoped. Kortix refuses it on every other
   project (`403 Project-scoped token cannot access a different project`), on
   `GET /projects` and on account routes. Tenant isolation is Kortix's, not a
   filter in Lumen.
5. A project-scoped token carries its minter's role on that project (owner).
   `src/server/proxy-policy.ts` narrows it: reads are open except the routes
   that issue credentials; writes are allowed only on the session surface
   (sessions, attachments, approvals, the runtime). Agent config, secrets,
   members, triggers, connectors, tokens and project deletion return `403`.
6. Every token Lumen mints is revoked at its expiry by a scheduled Convex
   action (`kortix.revokeToken`). A preview iframe gets its own 15-minute
   token, because that URL reaches the browser.

## Setup

Prerequisites: a Kortix API URL and an operator token for the Kortix account
that will own Lumen's projects (an account-level PAT or a service-account
key; use an account named after your product, because its email appears as
the prompt author in session transcripts).

```bash
pnpm install

# 1. Convex, local, no Convex account needed. Keeps running; state is in .convex/.
pnpm --filter @kortix/whitelabel-demo dev:convex     # writes .env.local

# 2. Convex env (second terminal, in apps/whitelabel-demo).
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
npx convex env set SITE_URL http://localhost:3020          # the browser origin
npx convex env set KORTIX_UPSTREAM https://api.kortix.com/v1
npx convex env set KORTIX_OPERATOR_TOKEN <operator token>
npx convex env set LUMEN_PROXY_SECRET "$(openssl rand -hex 24)"
npx convex run templates:seed                              # the three agent templates

# 3. Next.js env: append to .env.local (see .env.example).
#    KORTIX_UPSTREAM=<same as Convex>  LUMEN_PROXY_SECRET=<same as Convex>

# 4. Next.js.
WHITELABEL_PORT=3020 pnpm --filter @kortix/whitelabel-demo dev
```

A developer with a Convex login can run `npx convex dev` instead of
`dev:convex`; no code changes. For production, deploy Convex
(`npx convex deploy`), set the same env there, and set `SITE_URL` to the
public origin.

`SITE_URL` must equal the origin the browser uses. Better Auth refuses a
request from any other origin.

Against a local Kortix worktree stack, `KORTIX_UPSTREAM` is
`http://localhost:<worktree api port>/v1`. The Kortix API's CORS allowlist does
not matter here: the browser only calls Lumen's own origin.

## Screens

| Route | Screen |
|---|---|
| `/` | Sign in / sign up; then the active organization's workspaces, "New workspace" (template cards) |
| header | Organization switcher, "New organization", Members (list + invite link), sign out |
| `/invite/<id>` | Accept an invitation (sign in with the invited email) |
| `/w/<workspaceId>` | Workspace: setup status, ask the agent (starts a thread), thread list |
| `/projects/<projectId>/sessions/<sessionId>` | The thread: the shared session workbench. `src/app/projects/[id]/layout.tsx` maps the project to its workspace and checks membership first |

There is no email provider in this example. An invitation is a link the
inviter copies from the Members dialog. Production adds email verification and
`organization({ sendInvitationEmail })` in `convex/auth.ts`.

## Code map

| Path | What |
|---|---|
| `convex/schema.ts` | `agentTemplates`, `workspaces`, `threads`, `memberTokens`, `auditEvents` |
| `convex/auth.ts`, `convex/betterAuth/` | Better Auth as a local Convex component, with the organization plugin |
| `convex/kortix.ts` | Every operator call to Kortix (`"use node"` actions): provision, create thread, member and preview tokens, revoke |
| `convex/workspaces.ts`, `convex/threads.ts`, `convex/templates.ts` | Queries and mutations; reads return null or empty for a non-member |
| `src/server/member.ts` | Bearer + cookie → member token (Convex), cached per minute |
| `src/server/proxy-policy.ts` | What a member token may do through the proxy |
| `src/app/api/kortix/[...path]/route.ts` | The same-origin proxy; tags and records sessions created from the session UI |
| `src/app/api/preview-url`, `session-model`, `connections` | Server routes on the member token |
| `src/lib/kortix.ts` | The one browser SDK client (`backendUrl: '/api/kortix'`) |
| `src/lib/session.ts` | The active workspace bearer |

## Client boundary

Client code imports Kortix only through `@kortix/sdk`, `@kortix/sdk/react`,
`@kortix/ui/<entry>` and `@phosphor-icons/react`. It never sends raw requests
to the Kortix backend; its own `fetch` calls go to `/api/auth`,
`/api/connections`, `/api/preview-url` and `/api/session-model` only. Convex
files import `@kortix/sdk` only in `"use node"` files and never call `fetch`.
`scripts/sdk-boundary.mjs` enforces all of this and runs before `build`,
`test` and `typecheck`.

## Verify

```bash
pnpm --filter @kortix/whitelabel-demo typecheck   # boundary + tsgo (app) + tsgo -p convex
pnpm --filter @kortix/whitelabel-demo build
cd apps/whitelabel-demo && bun test tests/e2e/proxy-policy.test.ts   # one file; the full app suite takes ~1 s
```

The unit tests cover the proxy policy, upstream path validation, the SDK
boundary and the session UI helpers. The end-to-end flow (sign up, org,
workspace, thread, cross-org denial, invitation) needs Convex and a Kortix
stack; run it by hand with the steps in Setup.

## UI and rebrand

- Name and tagline: `src/config/brand.ts`. Colors, radius, fonts:
  `src/config/theme.ts` and the token overrides in `src/app/globals.css`.
  Never fork a `@kortix/ui` component.
- Agent templates: `convex/templates.ts` (`SEED`), then
  `npx convex run templates:seed`. A template is a slug, a name, a tagline and
  an agent prompt; provisioning installs it as the workspace project's default
  agent.
- A missing primitive or chat slot is added to `packages/ui`, not to this app.
- Missing backend behavior is added to `@kortix/sdk` before this app uses it.
