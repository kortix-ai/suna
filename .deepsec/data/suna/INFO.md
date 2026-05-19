# suna

## What this codebase does

Kortix is a repo-backed operating system for autonomous company agents. The monorepo contains a Next.js web app, Bun/Hono API, Supabase auth/database, Drizzle schema, CLI/mobile/desktop clients, and sandbox/agent packages. The highest-risk server code is under `apps/api/src`: account and project management, GitHub repo/session lifecycle, secrets/OAuth credentials, LLM routing, billing, setup, webhooks, tunnel/device auth, and the sandbox preview proxy.

## Auth shape

- API routes use Hono middleware. `supabaseAuth` requires Supabase JWTs or `kortix_pat_` CLI PATs and sets `userId`; `apiKeyAuth` validates `kortix_` / `kortix_sb_` API keys through `validateSecretKey`; `combinedAuth` accepts Supabase JWTs, Kortix keys, preview cookies, and limited preview query tokens.
- Platform admin checks are explicit: `requireAdmin`, `getPlatformRole`, and `isPlatformAdmin`. Do not treat account owner/admin as platform admin.
- Account/project access is separate from authentication. Project handlers should go through `loadProjectForUser(c, projectId, action)` and the `effectiveProjectRole` / `roleAllows` helpers before reading or mutating project data, Git files, sessions, triggers, secrets, deployments, or change requests.
- Sandbox preview access is gated by `combinedAuth` plus `canAccessPreviewSandbox` / `resolvePreviewUserContext`; service-to-sandbox forwarding uses an internal `serviceKey`, not the caller's JWT.
- Web access is enforced in `apps/web/src/middleware.ts`; public marketing/auth/install/share routes are allowlisted, while `/projects`, `/accounts`, `/invites`, and `/admin` require a Supabase session.

## Threat model

Top impact is cross-account or cross-project access: reading or mutating another account's repo, sessions, change requests, secrets, OAuth credentials, sandboxes, billing, or admin state. Next is sandbox escape or proxy abuse: using preview, share, tunnel, session LLM, deployment, or webhook routes to reach internal services, exfiltrate project secrets, or burn credits. Public ingress points such as setup, OAuth, webhooks, device auth, access requests, and preview auth need tight route-specific validation because they intentionally run before normal dashboard auth.

## Project-specific patterns to flag

- Any `projectsApp` handler touching a `:projectId` without `loadProjectForUser(c, projectId, "read" | "write" | "manage")`, or using only `supabaseAuth` for project-scoped data.
- Any route that reads, writes, merges, archives, or diffs Git repo content without checking project access first. Relevant helpers include `readRepoFile`, `listRepoFiles`, `commitFile`, `deleteFile`, `mergeBranches`, `previewMerge`, and `archiveRepoSubtree`.
- Any sandbox preview/proxy/share/tunnel path that accepts `sandbox_id`, port, token, or URL parameters without `combinedAuth`, ownership checks, provider lookup against `session_sandboxes`, and bounded timeouts.
- Any handler returning project secrets, OAuth tokens, API/PAT secret material, service keys, GitHub tokens, or setup commands outside one-time creation or sandbox environment injection paths.
- Any local/self-hosted setup or bootstrap endpoint reachable in cloud mode, or any public endpoint that can create users, modify env/system state, start sandboxes, or trigger agent sessions without a mode gate and explicit validation.

## Known false-positives

- Public health/status endpoints are intentional: `/health`, `/v1/health`, `/v1/system/status`, router health, and simple frontend install/marketing pages.
- `accessControlApp` public routes (`/v1/access/signup-status`, `/check-email`, `/request-access`) are signup-gating endpoints and intentionally unauthenticated.
- Setup routes `/v1/setup/install-status`, `/sandbox-providers`, and `/bootstrap-owner` are public by design but are only mounted when `config.isLocal()` in self-hosted/local mode.
- OAuth `/v1/oauth/authorize` and `/v1/oauth/token` are public protocol endpoints; consent uses `supabaseAuth`, token exchange validates client secrets, redirect URI allowlists, PKCE, single-use codes, refresh-token rotation, and rate limits.
- Tunnel device-auth start/status routes are public for CLI pairing. Preview proxy query-token support is a last resort for WebSocket/SSE routes where browsers cannot send custom headers.
