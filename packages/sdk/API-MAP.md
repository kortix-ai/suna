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
- **gateway observability** (`/v1/projects/:id/gateway/{overview,logs,keys,budgets,series,errors}`) → 🟡 has `projects-gateway-client.ts` in web, NOT in SDK

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

### 10. Workspace files  ❌ **the real gap**
Daemon-direct (bypasses v2 client), **not wrapped by SDK** — web hits these via `authenticatedFetch`:
| op | daemon HTTP |
|---|---|
| list dir | `GET /file?path=` |
| read text | `GET /file/content?path=` |
| read binary | `GET /file/raw?path=` |
| git status | `GET /file/status` |
| find files | `GET /find/file?query=&type=` (also `client.find.files`) |
| ripgrep text | `GET /find?pattern=` |
| upload / mkdir / rename / delete | `POST /file/upload`, `POST /file/mkdir`, `POST /file/rename`, `DELETE /file` |
SDK ships only `findOpenCodeFiles` (search helper) + `file-keys` (query keys). Hooks live in `features/files/` (+ duplicated in `features/project-files/`). **Dead exports to drop: `useLssSearch`, `useWorkspaceSearch`, `useTextSearch`.**

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
- `GET /v1/projects/:id/{sandbox-health,sandboxes}`, snapshots, warm-pool, `GET /v1/platform/sandbox/version*` → 🟡 web-local (`hooks/platform`, `lib/platform-client`)
- sandbox proxy `ALL /v1/p/:sandboxId/:port/*` + preview auth/share → used by opencode-client baseURL ✅

### 15. Account state / billing (for entitlement + UI)  🟡
`GET /v1/billing/account-state` (+ minimal) → web-local (`hooks/billing`, `lib/api/billing`). Needed by the SDK consumer for tier/entitlement gating; the rest of `/v1/billing/*` (checkout/credits/portal) is product-UI, optional for SDK.

### 16. Transcription / misc session input  🟡
`POST /v1/transcription` (voice) → web-local.

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
| Skills create/update/delete | ❌ web-local (daemon file I/O) |
| **Workspace files (read/write/status/search)** | ❌ **not wrapped — the core gap** |
| Git / versions / change-requests | 🟡 client fns ✅, hooks web-local |
| Gateway observability, triggers, sandbox-admin, executor, billing, transcription | 🟡 web-local |

### To make the SDK the whole data layer
1. **Add a `files` client to the SDK** wrapping the daemon `/file` + `/find` endpoints → move `features/files` hooks in; **collapse the `features/project-files` twin** into it (backend-parameterized); **drop the 3 dead search hooks**.
2. **Wrap the existing client fns as hooks** in the SDK: git/versions/change-requests, triggers, gateway-observability, sandbox-admin, account-state.
3. Everything else (the agent loop) is already SDK — that's the verified path.
