# Kortix SDK — Complete API Map

The surface the `@kortix/sdk` must wrap to be the whole data layer for web + mobile + reference apps.

Two layers, one client:

| Layer | Reached via | Owns |
|---|---|---|
| **Kortix REST API** (`apps/api`, `/v1/*`) | `backendApi` (Supabase bearer) | control plane — projects, session lifecycle, sandbox provisioning, git/versions, secrets, billing |
| **OpenCode runtime** (in-sandbox daemon) | `/v1/p/{sandboxId}/8000/...` proxy → OpenCode v2 client + raw daemon `/file`·`/find` | agent runtime — messages, events, files, pty, permissions |

Legend: **✅ in SDK** · **🟡 partial** (client fn in SDK, hook not) · **❌ gap** (web-local / not wrapped)

---

## IN SCOPE — the agent product (what the SDK needs)

### 1. Auth / session token  ✅
Injection seam, not an endpoint. `configureKortix({ getToken })` → Supabase token on every request; 401 retry; cache invalidation.

### 2. Projects  ✅
| op | Kortix REST | SDK |
|---|---|---|
| list / get / create / update | `GET/POST /v1/projects`, `GET/PUT /v1/projects/:id` | ✅ |
| detail (config+agents+skills+files) | `GET /v1/projects/:id/detail` | ✅ |
| provision / link repo / create repo | `POST /v1/projects/{provision,link-repository,create-repo}` | ✅ |
| github installs / repos / collaborators | `GET /v1/projects/github/*`, `/:id/git/collaborators` | ✅ |
| llm-catalog | `GET /v1/projects/:id/llm-catalog` | ✅ |
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
| transcript | `GET .../sessions/:sid/transcript` |
| preview candidates (live ports) | `GET .../sessions/:sid/previews` |
| public shares | `GET/POST/DELETE .../sessions/:sid/public-shares[/:id]` |

### 6. Session runtime — the agent loop (OpenCode)  ✅
| op | v2 client / daemon |
|---|---|
| create / list / get / delete / update | `client.session.{create,list,get,delete,update}` |
| fork / init / summarize / abort | `client.session.{fork,summarize,abort}`, `/kortix/abort` |
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
`client.pty.{list,create,remove,update}` + `WS /pty/:id/connect?token=` → `getPtyWebSocketUrl`.

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
Client fns in SDK (`git-history.ts`, `change-requests.ts`), **hooks web-local** (`features/project-files`):
| op | REST |
|---|---|
| commits / commit / diff | `GET /v1/projects/:id/commits[/:sha][/diff]` |
| branches | `GET /v1/projects/:id/branches` |
| file history / version-diff | `GET /v1/projects/:id/files/history`, `/version-diff` |
| change-requests CRUD | `GET/POST/PUT /v1/projects/:id/change-requests[/:cr]` |
| merge / merge-preview / close / reopen | `POST .../change-requests/:cr/{merge,close,reopen}`, `GET .../merge-preview` |
| project files (git-backed) | `GET /v1/projects/:id/files`, `POST /files/{content,search}`, `GET /files/archive` |

### 12. Connectors / integrations  ✅ (project) · 🟡 (executor)
- project connectors + sharing/policies → `projects-client/{connectors,policies}.ts` ✅
- executor runtime (`/v1/executor/projects/:id/connectors/*`, Slack/Pipedream/CUA) → 🟡 web-local (`lib/*`)

### 13. Triggers / scheduled tasks  🟡
`projects-client/triggers.ts` ✅ (client) ; hooks web-local (`hooks/scheduled-tasks`).

### 14. Sandbox lifecycle  ✅ / 🟡
- session-sandbox status/metrics/instances → `projects-client/{sandbox,session-sandbox}.ts` ✅
- `GET /v1/projects/:id/{sandbox-health,sandboxes}`, snapshots, warm-pool, `GET /v1/platform/sandbox/version*` → 🟡 client in `@kortix/sdk/platform-client` ✅; hooks web-local (`hooks/platform`)
- sandbox proxy `ALL /v1/p/:sandboxId/:port/*` + preview auth/share → used by opencode-client baseURL ✅

### 15. Account state / billing (for entitlement + UI)  🟡
`GET /v1/billing/account-state` (+ minimal) client now in SDK (`projects-client/billing.ts`) ✅; hooks still web-local (`hooks/billing`, `lib/api/billing`) 🟡. Needed by the SDK consumer for tier/entitlement gating; the rest of `/v1/billing/*` (checkout/credits/portal) is product-UI, optional for SDK.

### 16. Transcription / misc session input  🟡
`POST /v1/transcription` (voice) client now in SDK (`projects-client/transcription.ts`) ✅; hooks still web-local (`hooks/transcription`) 🟡.

### 17. Channels / apps (project-scoped)  🟡
Slack/email inbound-outbound installs (`projects-client/channels.ts`) and the `/v1/projects/:id/apps/*` deployment family (`projects-client/apps.ts`) — clients ✅ in SDK; hooks web-local.

---

## OUT OF SCOPE — control plane / platform admin (NOT the SDK)
Map exists, but these belong to the platform app, not the agent SDK:
- **Accounts IAM v2** — groups, service-accounts, SCIM tokens, SSO/SAML, session/MFA/PAT policy, audit (`/v1/accounts/:id/iam/*`, `/scim/v2/*`)
- **Admin console** — tiers, credits debit, provider analytics/distribution/fallback, warm-pool/snapshot config (`/v1/admin/*`)
- **Ops** — `/v1/ops/overview`
- **Tunnel** — device-auth, tunnel lifecycle, agent WS (`/v1/tunnel/*`)
- **Marketplace** — catalog/items/sources (`/v1/marketplace/*`)
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
| Skills create/update/delete | ❌ web-local (daemon file I/O) |
| Git / versions / change-requests, gateway observability, triggers, sandbox-admin, billing/account-state, transcription, channels, apps | 🟡 client fns ✅ in SDK, hooks still web-local |
| Executor connectors runtime | 🟡 web-local |
| kortix-master daemon family (tasks/tickets/projects/milestones/credentials/services) | 🟡 client landing in this branch (`opencode/kortix-master.ts`), not yet exported from the SDK barrel; hooks web-local |

### To make the SDK the whole data layer
1. ~~Add a `files` client to the SDK~~ — **done**: `@kortix/sdk/files` wraps the daemon `/file` + `/find` endpoints (12 ops). Remaining: move `features/files` hooks in; **collapse the `features/project-files` twin** into it (backend-parameterized).
2. **Wrap the existing client fns as hooks** in the SDK: git/versions/change-requests, triggers, gateway-observability, sandbox-admin, billing/account-state.
3. ~~Framework-free event stream~~ — **done**: `openEventStream` (`@kortix/sdk` root barrel / `@kortix/sdk/event-stream`) is a framework-free connect/reconnect/heartbeat/coalescing primitive with zero React deps, and `session.stream()` is a thin facade over it (`ensureReady()` + the session's own runtime client). `@kortix/sdk/react`'s `useOpenCodeEventStream` is now just a React wrapper around the same primitive — a non-React host (server wrapper, worker, CLI) subscribes directly via `session.stream()` or `openEventStream()`.
4. **Land + export the kortix-master daemon client** (tasks/tickets/projects/milestones/credentials/services) from the SDK barrel once its hooks move down.
5. **Mobile adoption** — the SDK is the shared implementation in principle, but the mobile app hasn't migrated its data layer onto it yet.
6. Everything else (the agent loop) is already SDK — that's the verified path.
