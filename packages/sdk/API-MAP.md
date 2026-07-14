# Kortix SDK — Complete API Map

The surface the `@kortix/sdk` must wrap to be the whole data layer for web + mobile + reference apps.

Two layers, one client:

| Layer | Reached via | Owns |
|---|---|---|
| **Kortix REST API** (`apps/api`, `/v1/*`) | `backendApi` (Supabase bearer) | control plane — projects, session lifecycle, sandbox provisioning, git/versions, secrets, billing |
| **OpenCode runtime** (in-sandbox daemon) | `/v1/p/{sandboxId}/8000/...` proxy → OpenCode v2 client + raw daemon `/file`·`/find` | agent runtime — messages, events, files, pty, permissions |

Legend: **✅ in SDK** · **🟡 partial** (client fn in SDK, hook not) · **❌ gap** (web-local / not wrapped)

---

## Stability

Package-shape guarantees — orthogonal to the domain-coverage legend above,
which tracks how much of the REST + runtime surface is wrapped, not how stable
a given import path is:

| Tier | Entries | Guarantee |
|---|---|---|
| Stable | `.`, `./react`, `./server` | semver |
| Deprecated | the 20 legacy subpaths | works; removed on the next major |
| Internal | `./internal/*` | **no guarantee**, may change in any release |

`.` is the canonical entry — everything framework-free lives there. `./react`
and `./server` exist because React is a peer dependency and `./server` statically
imports `node:async_hooks`, respectively. The 20 legacy subpaths
(`@kortix/sdk/projects-client`, `/turns`, `/files`, `/session`, `/event-stream`,
the zustand stores, …) are `@deprecated` aliases that still resolve — import from
the root instead. `./internal/*` backs `apps/web`'s zustand stores and is not
reachable from `window.Kortix`; treat it as visible implementation detail, not
designed API.

---

## IN SCOPE — the agent product (what the SDK needs)

### 1. Auth / session token  ✅
Injection seam, not an endpoint. `configureKortix({ getToken })` → Supabase token on every request; 401 retry; cache invalidation.

### 1b. Token validation helper (pasted-API-key UX)  ✅
`kortix.validateToken()` → `GET /v1/accounts/me`. Never throws — resolves
`{valid: boolean, identity?: AccountIdentity, error?: ApiError}`. Built for a
setup screen that needs to render "invalid token" inline instead of
try/catching every call.

### 2. Projects  ✅
| op | Kortix REST | SDK |
|---|---|---|
| list / get / create / update | `GET/POST /v1/projects`, `GET/PUT /v1/projects/:id` | ✅ |
| detail (config+agents+skills+files) | `GET /v1/projects/:id/detail` | ✅ |
| provision / import linked repo / create repo | `POST /v1/projects/{provision,link-repository,create-repo}` | ✅ |
| github installs / repos / repository branches / collaborators | `GET /v1/projects/github/*`, `/:id/git/collaborators` | ✅ |
| model catalogs | `GET /v1/projects/:id/llm-catalog` (full runtime), `GET /v1/projects/:id/model-picker` (compact connected UI picker) | ✅ |
| experimental flags / onboarding | `GET/PUT /v1/projects/:id/{experimental,onboarding}` | ✅ |

### 3. Project secrets / env  ✅
`GET/POST/PUT/DELETE /v1/projects/:id/secrets[/:name]` · personal overrides · OAuth credential flow (`/oauth/:provider/{start,poll}`) · git-credential. → SDK `projects-client/secrets.ts`.

### 4. Project access / IAM (project-scoped)  ✅
`/v1/projects/:id/access` (+ invite, remove, pending-invites, access-requests approve/reject, group-grants). → `projects-client/access.ts`.

### 5. Session lifecycle (Kortix side)  ✅
| op | REST |
|---|---|
| list / create | `GET/POST /v1/projects/:id/sessions` |
| get / update / delete | `GET/PUT/DELETE /v1/projects/:id/sessions/:sid` |
| **start** (provision + claim sandbox) | `POST .../sessions/:sid/start` |
| restart | `POST .../sessions/:sid/restart` |
| commit + push | `POST .../sessions/:sid/commit-push` |
| sharing (project) | `GET/PUT .../sessions/:sid/sharing` |
| transcript | `GET .../sessions/:sid/transcript` → `projects-client/sessions.ts`'s `getSessionTranscript` ✅, facade `session(pid,sid).transcript()` ✅ (previously listed ✅ here with no client fn behind it — that was false; now genuinely wired) |
| preview candidates (live ports) | `GET .../sessions/:sid/previews` |
| public shares | `GET/POST/DELETE .../sessions/:sid/public-shares[/:id]` |

### 5b. Token minting (CLI PATs) — Kortix-as-a-Backend-critical  ✅
| op | REST | SDK |
|---|---|---|
| list / create / revoke (account-scoped) | `GET/POST /v1/accounts/tokens`, `DELETE /v1/accounts/tokens/:tokenId` | `projects-client/tokens.ts` ✅, facade `kortix.accounts.tokens.{list,create,revoke}` ✅ |
| list / create / revoke (project-scoped, `KORTIX_TOKEN`) | `GET/POST /v1/projects/:id/cli-token`, `DELETE .../cli-token/:tokenId` | ✅, facade `project(id).tokens.{list,create,revoke}` ✅ |

### 6. Session runtime — the agent loop (OpenCode)  ✅
| op | v2 client / daemon |
|---|---|
| create / list / get / delete / update | `client.session.{create,list,get,delete,update}` |
| init / summarize / abort | `client.session.summarize`, `/kortix/abort` |
| messages | `client.session.messages` → `GET /session/:id/message` |
| **send prompt (sync / async)** | `client.session.prompt` → `POST /session/:id/prompt[_async]` |
| parts edit / delete | `client.part.{update,delete}` |
| **events (SSE)** | `client.global.event()` → `/global/event` (session.*, message.*, part.*, pty.*, permission.request, question.request, lsp.*, instance.disposed) |
| permissions reply | `client.permission.reply` |
| questions reply / reject | `client.question.{reply,reject}` |
| diff / todo | `client.session.{diff,todo}` |
| status | `client.session.status` |

### 7. Models / gateway  ✅
- runtime providers+models: `client.provider.list` → `/provider/list` (filtered to `kortix` + `opencode`)
- catalog/budget: `GET /v1/llm/models`, `GET /v1/projects/:id/llm-catalog`
- selection + persistence: `useOpenCodeLocal`, `useModelStore` ✅
- **gateway observability** (`/v1/projects/:id/gateway/{overview,logs,keys,budgets,series,errors}`) → client fully in SDK (`projects-client/gateway.ts`) ✅; hooks still web-local 🟡
- **gateway playground** — `project(id).gateway.playground(prompt, models)` → `POST /v1/projects/:id/gateway/playground` (run one prompt against up to 6 models side by side) ✅

### 8. Agents · commands · tools · skills · MCP
| op | runtime | SDK |
|---|---|---|
| agents list/get/visible | `client.app.agents` | ✅ |
| commands list/execute | `client.command.list`, `client.session.command` | ✅ |
| tools ids / list | `client.tool.{ids,list}` | ✅ |
| skills **list** | `client.app.skills` → `/skill` | ✅ |
| skills **create/update/delete** | daemon `/file/upload`,`/file/mkdir`,`DELETE /file` + `instance.dispose` | ❌ web-local (`features/skills`) |
| MCP status/add/connect/disconnect/oauth | `client.mcp.*` | ✅ |

### 9. Terminal (PTY)  ✅
Kortix-native (`opencode/pty.ts`), independent of the agent runtime — daemon
`/kortix/pty` (`list/create/update/remove`) + `WS /kortix/pty/:id/connect?token=`
→ `getKortixPtyWebSocketUrl`. Same hook names/shapes as before (`useOpenCodePtyList`,
`useCreatePty`, `useRemovePty`, `useUpdatePty`, `getPtyWebSocketUrl`) — only the
transport moved off `client.pty.*`/OpenCode's own `/pty`.

### 10. Workspace files  ✅ (client) · 🟡 (hooks)
Daemon-direct (bypasses v2 client), full 12-op client now in the SDK (`@kortix/sdk/files` → `files/client.ts`):
| op | daemon HTTP | SDK |
|---|---|---|
| list dir | `GET /file?path=` | ✅ `files.listFiles` |
| read text | `GET /file/content?path=` | ✅ `files.readFile` |
| read binary | `GET /file/raw?path=` | ✅ `files.readBlob` |
| git status | `GET /file/status` | ✅ `files.getFileStatus` |
| find files | `GET /find/file?query=&type=` (also `client.find.files`) | ✅ `files.findFiles` |
| ripgrep text | `GET /find?pattern=` | ✅ `files.findText` |
| upload / create / copy / delete / mkdir / rename | `POST /file/upload`, `POST /file/mkdir`, `POST /file/rename`, `DELETE /file` | ✅ `files.{uploadFile,createFile,copyFile,deleteFile,mkdir,renameFile}` |
React hooks are still web-local (`features/files/`, + duplicated in `features/project-files/` — collapsing that twin remains open). **`useWorkspaceSearch` is alive and consumed (`features/workspace/command-palette.tsx`) — not dead.** `useLssSearch` / `useTextSearch` are already gone.

### 11. Git / versions / change-requests  🟡
Client fns in SDK (`git-history.ts`, `change-requests.ts`), **hooks partial** (`useChangeRequests` in `@kortix/sdk/react` ✅; the rest of `features/project-files` is still web-local):
| op | REST |
|---|---|
| commits / commit / diff | `GET /v1/projects/:id/commits[/:sha][/diff]` |
| branches | `GET /v1/projects/:id/branches` |
| file history / version-diff | `GET /v1/projects/:id/files/history`, `/version-diff` |
| change-requests CRUD | `GET/POST/PUT /v1/projects/:id/change-requests[/:cr]` |
| merge / merge-preview / close / reopen | `POST .../change-requests/:cr/{merge,close,reopen}`, `GET .../merge-preview` |
| **request-changes** (Review Center feedback) | `POST .../change-requests/:cr/request-changes` → client fn already existed (`requestChangesOnChangeRequest`), now also on the facade: `project(id).changeRequests.requestChanges(crId, feedback)` ✅ |
| project files (git-backed) | `GET /v1/projects/:id/files`, `POST /files/{content,search}`, `GET /files/archive` |

### 12. Connectors / integrations  ✅ (project) · 🟡 (executor)
- project connectors + sharing/policies → `projects-client/{connectors,policies}.ts` ✅
- executor runtime (`/v1/executor/projects/:id/connectors/*`, Slack/Pipedream/CUA) → 🟡 web-local (`lib/*`)

### 13. Triggers / scheduled tasks  🟡
`projects-client/triggers.ts` ✅ (client) ; `useProjectTriggers` now in `@kortix/sdk/react` ✅ (list + create/update/remove/fire, invalidation-wired); the web app's own `hooks/scheduled-tasks` hook hasn't migrated onto it yet.

### 13b. Marketplace / registry install (project-scoped)  ✅
Installing/updating/removing a catalog item onto a project's default branch (a commit, not a runtime call) — distinct from browsing the catalog itself (client fns in `projects-client/marketplace-catalog.ts`, now also wrapped on the facade as top-level `kortix.marketplace.*` — see §13c). `projects-client/marketplace.ts` ✅; facade `project(id).marketplace.{list,install,updates,update,updateAll,remove}` and the identical `project(id).registry.{...}` alias ✅:
| op | REST |
|---|---|
| install | `POST /v1/projects/:id/marketplace/install` (+ `/registry/install` alias) |
| list installed | `GET /v1/projects/:id/marketplace` (+ `/registry` alias) |
| check for updates | `GET /v1/projects/:id/marketplace/updates` (+ `/registry/updates` alias) |
| update one / update all | `POST /v1/projects/:id/marketplace/{update,update-all}` (+ `/registry/...` alias) |
| remove | `DELETE /v1/projects/:id/marketplace/:name` (+ `/registry/:name` alias) |

### 13c. Marketplace catalog browse (public) + sources  ✅
Previously OUT OF SCOPE ("Marketplace catalog browsing"). Now wrapped
end-to-end: client fns in `projects-client/marketplace-catalog.ts` are on the
facade as `kortix.marketplace.{items, item, itemFile, marketplaces, featured,
sources: {list, add, remove}}` (top-level — distinct from the install-scoped
`project(id).marketplace.*` in §13b):
| op | REST |
|---|---|
| browse catalog items (query/type/source filter) | `GET /v1/marketplace/items` |
| distinct marketplaces + item counts | `GET /v1/marketplace/marketplaces` |
| curated featured marketplaces | `GET /v1/marketplace/marketplaces/featured` |
| item detail | `GET /v1/marketplace/items/:id` |
| item file content | `GET /v1/marketplace/items/:id/file?path=` |
| sources CRUD (authed, platform-global "Add a marketplace") | `GET/POST /v1/marketplace/sources`, `DELETE /v1/marketplace/sources/:id` |

### 13d. Agent-minted setup links  ✅
Short-lived links the in-sandbox agent mints so a human can enter a secret
value or 1-click connect a Pipedream app, without the agent ever seeing the
value/credential. `projects-client/setup-links.ts` ✅; facade
`project(id).setupLinks.{requestSecret, requestConnector}` ✅:
| op | REST |
|---|---|
| mint a secret-entry link | `POST /v1/projects/:id/secret-requests` |
| mint a Pipedream Quick Connect link | `POST /v1/projects/:id/connect-requests` |

### 13e. Manifest validate + git token  ✅
Two small project-scoped mutations, added to `projects-client/projects.ts`:
- `project(id).validateManifest(raw)` → `POST /v1/projects/:id/manifest/validate`
  (validates a `kortix.yaml` — or legacy `kortix.toml` — manifest's raw text
  server-side, format auto-resolved from the project's manifest path; same
  schema `kortix ship`/`kortix validate`/the CR-merge gate use; always
  resolves with `{valid, issues}`, never throws on an invalid manifest).
- `project(id).gitToken()` → `POST /v1/projects/:id/git-token` (mints a
  fresh scoped git push token for a *managed* project; throws/409s for BYO
  repos).

### 14. Sandbox lifecycle  ✅ / 🟡
- session-sandbox status/metrics/instances → `projects-client/{sandbox,session-sandbox}.ts` ✅
- `GET /v1/projects/:id/{sandbox-health,sandboxes}`, snapshots, warm-pool, `GET /v1/platform/sandbox/version*` → 🟡 client in `@kortix/sdk/platform-client` ✅; hooks web-local (`hooks/platform`)
- sandbox proxy `ALL /v1/p/:sandboxId/:port/*` + preview auth/share → used by opencode-client baseURL ✅

### 15. Billing  ✅ (read + a curated mutation surface)
Read surface (unchanged) — `kortix.billing.{accountState, accountStateMinimal,
transactions, transactionsSummary, creditBreakdown, usageHistory,
tierConfigurations}` ✅. Hooks still web-local (`hooks/billing`) 🟡.
| op | REST |
|---|---|
| account state (full / minimal) | `GET /v1/billing/account-state[/minimal]` |
| transactions (paginated) / summary | `GET /v1/billing/transactions`, `/transactions/summary` |
| credit breakdown | `GET /v1/billing/credit-breakdown` |
| usage history | `GET /v1/billing/usage-history` |
| tier configurations (public pricing) | `GET /v1/billing/tier-configurations` |

Mutations — a deliberately curated subset of `apps/api/src/billing/routes`
(Stripe-webhook-only routes and legacy/per-seat-claim internals stay
unwired) now live in `projects-client/billing.ts` and are grouped on the
facade as `kortix.billing.{checkout, subscription, credits}`:
| group | op | REST |
|---|---|---|
| `checkout` | createSession | `POST /v1/billing/create-checkout-session` |
| `checkout` | confirmSession | `POST /v1/billing/confirm-checkout-session` |
| `subscription` | createPortalSession | `POST /v1/billing/create-portal-session` |
| `subscription` | cancel | `POST /v1/billing/cancel-subscription` |
| `subscription` | reactivate | `POST /v1/billing/reactivate-subscription` |
| `subscription` | scheduleDowngrade | `POST /v1/billing/schedule-downgrade` |
| `subscription` | cancelScheduledChange | `POST /v1/billing/cancel-scheduled-change` |
| `subscription` | prorationPreview | `GET /v1/billing/proration-preview` |
| `credits` | purchase | `POST /v1/billing/purchase-credits` |
| `credits` | autoTopupSettings | `GET /v1/billing/auto-topup/settings` |
| `credits` | configureAutoTopup | `POST /v1/billing/auto-topup/configure` |

### 16. Transcription / misc session input  🟡
`POST /v1/transcription` (voice) client now in SDK (`projects-client/transcription.ts`) ✅; hooks still web-local (`hooks/transcription`) 🟡.

### 17. Channels (project-scoped)  🟡
Slack/email inbound-outbound installs live in `projects-client/channels.ts`; hooks remain web-local.
Also now wrapped: Slack file download/upload proxies
(`project(id).channels.slack.{getFile, uploadFile}` →
`GET/POST /v1/projects/:id/channels/slack/file[/upload]`) and the Meet
"bot speaks" action (`project(id).channels.meet.speak(botId, text, voice?)`
→ `POST /v1/projects/:id/channels/meet/speak`).

### 18. Account audit log (Enterprise)  ✅ (client + facade) / 🟡 (hooks)
Event list + CSV/JSONL export + outbound SIEM webhook CRUD, gated server-side on `audit.read`/`account.write` + the account's `auditAccess` entitlement. `projects-client/audit.ts` ✅; facade `kortix.accounts.audit.{log, export, webhooks: {list,create,update,remove}}` ✅ (accountId-first, like the rest of `kortix.accounts.*`); no hooks yet (this is an admin-console surface, low priority for the agent-product hooks):
| op | REST |
|---|---|
| list events (cursor-paginated) | `GET /v1/accounts/:id/audit` |
| export (CSV/JSONL) | `GET /v1/accounts/:id/audit/export` |
| webhooks CRUD | `GET/POST /v1/accounts/:id/audit/webhooks`, `PATCH/DELETE .../:webhookId` |

---

## OUT OF SCOPE — control plane / platform admin (NOT the SDK)
Map exists, but these belong to the platform app, not the agent SDK:
- **Accounts IAM v2** — groups, service-accounts, SCIM tokens, SSO/SAML, session/MFA/PAT policy (`/v1/accounts/:id/iam/*`, `/scim/v2/*`). (Account **audit** — event log, export, SIEM webhooks — is now IN SCOPE, see §18; it's the one IAM-v2-adjacent surface the SDK wraps because a "Kortix as a Backend" host needs to read its own compliance trail.)
- **Admin console** — tiers, credits debit, provider analytics/distribution/fallback, warm-pool/snapshot config (`/v1/admin/*`)
- **Ops** — `/v1/ops/overview`
- **Tunnel** — device-auth, tunnel lifecycle, agent WS (`/v1/tunnel/*`)
- **Channels webhooks** — slack/email/telegram/sandbox-provider (`/v1/webhooks/*`)
- **OAuth2 provider + git smart-http + setup/system/access-control** (`/v1/oauth/*`, `/v1/git/*`, `/v1/setup/*`, `/v1/system/*`, `/v1/access/*`)
- **LLM gateway internals** — `/v1/router/*`, `/v1/llm/*`, `/internal/gateway/*` (the gateway calls these; the agent SDK only consumes models, not the routing control plane)

---

## Coverage summary

| Domain | Status |
|---|---|
| Auth, Projects, Secrets, Access, Session lifecycle | ✅ complete |
| Session runtime (messages/events/permissions/diff/todo) | ✅ complete |
| Models, Agents, Commands, Tools, MCP, PTY | ✅ complete |
| **Workspace files (read/write/status/search)** | ✅ full client in SDK (`@kortix/sdk/files`); hooks web-local |
| Token minting (account + project-scoped CLI PATs) | ✅ complete — `projects-client/tokens.ts`, facade `kortix.accounts.tokens.*` / `project(id).tokens.*` |
| Marketplace/registry install (project-scoped) | ✅ complete — `projects-client/marketplace.ts`, facade `project(id).marketplace.*` / `.registry.*` |
| Public marketplace catalog browse + sources | ✅ complete — `projects-client/marketplace-catalog.ts`, facade `kortix.marketplace.*` |
| Billing mutations (checkout/subscription/credits) | ✅ complete — `projects-client/billing.ts`, facade `kortix.billing.{checkout, subscription, credits}` |
| Setup links, manifest validate, git token | ✅ complete — facade `project(id).{setupLinks, validateManifest, gitToken}` |
| Account audit (Enterprise) | ✅ client + facade (`kortix.accounts.audit.*`); 🟡 no hooks yet |
| Skills create/update/delete | ❌ web-local (daemon file I/O) |
| Git / versions / change-requests, gateway observability, sandbox-admin, billing/account-state, transcription | 🟡 client fns ✅ in SDK, hooks still web-local |
| Channels (Slack/email/Meet installs) | 🟡 client fns ✅ in SDK, hooks still web-local — now also includes the Slack file get/upload proxy and Meet `speak` (client + facade wired; see §17) |
| Triggers, project secrets, change-requests | 🟡→partial ✅ — `useProjectTriggers`/`useProjectSecrets`/`useChangeRequests` now in `@kortix/sdk/react`; the pre-existing web hooks for these haven't migrated onto them yet |
| Executor connectors runtime | 🟡 web-local |
| kortix-master daemon family (tasks/tickets/projects/milestones/credentials/services) | ✅ client in SDK (`opencode/kortix-master.ts`, re-exported via `@kortix/sdk/opencode-client`) + hooks in `@kortix/sdk/react` (`use-kortix-master.ts`); web's `hooks/kortix/*` files are now thin re-export wrappers over them. Not on the ROOT barrel (deliberate — it's an opencode-runtime surface, reached via the opencode-client subpath) |

### To make the SDK the whole data layer
1. ~~Add a `files` client to the SDK~~ — **done**: `@kortix/sdk/files` wraps the daemon `/file` + `/find` endpoints (12 ops). Remaining: move `features/files` hooks in; **collapse the `features/project-files` twin** into it (backend-parameterized).
2. **Wrap the existing client fns as hooks** in the SDK: git/versions/change-requests (`useChangeRequests` ✅ done; commits/branches/diff still web-local), triggers (`useProjectTriggers` ✅ done), gateway-observability, sandbox-admin, billing/account-state.
3. ~~Framework-free event stream~~ — **done**: `openEventStream` (`@kortix/sdk` root barrel / `@kortix/sdk/event-stream`) is a framework-free connect/reconnect/heartbeat/coalescing primitive with zero React deps, and `session.stream()` is a thin facade over it (`ensureReady()` + the session's own runtime client). `@kortix/sdk/react`'s `useOpenCodeEventStream` is now just a React wrapper around the same primitive — a non-React host (server wrapper, worker, CLI) subscribes directly via `session.stream()` or `openEventStream()`.
4. ~~Land + export the kortix-master daemon client~~ — **done**: the client (`opencode/kortix-master.ts`) is re-exported from `@kortix/sdk/opencode-client`, and its React Query layer lives in `@kortix/sdk/react` (`use-kortix-master.ts`, with the injectable `KortixMasterIdentity` seam); apps/web's six former hook files (`hooks/kortix/*` + `hooks/use-sandbox-services.ts`) are thin wrappers over it.
5. **Mobile adoption** — the SDK is the shared implementation in principle, but the mobile app hasn't migrated its data layer onto it yet.
6. Everything else (the agent loop) is already SDK — that's the verified path.
