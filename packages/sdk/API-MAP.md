# Kortix SDK — Complete API Map

The surface the `@kortix/sdk` must wrap to be the whole data layer for web + mobile + reference apps.

Two layers, one client:

| Layer | Reached via | Owns |
|---|---|---|
| **Kortix REST API** (`apps/api`, `/v1/*`) | `backendApi` (the `getToken` bearer) | control plane — projects, session lifecycle, sandbox provisioning, git/versions, secrets, billing |
| **Session runtime** (kortixd, the in-sandbox daemon) | the Kortix runtime contract through the API proxy `/v1/p/{externalId}/8000/...` | agent runtime — messages, events, files, pty, permissions |

Legend: **✅ in SDK** · **🟡 partial** (client fn in SDK, hook not) · **❌ gap** (web-local / not wrapped)

---

## Stability

Package-shape guarantees — orthogonal to the domain-coverage legend above,
which tracks how much of the REST + runtime surface is wrapped, not how stable
a given import path is:

| Tier | Entries | Guarantee |
|---|---|---|
| Stable | `.`, `./react`, `./server`, `./genui`, `./genui/fence`, `./genui/react`, `./wire-message-id`, `./workspace-search`, `./capture-rules` | semver |
| Deprecated | the 21 legacy subpaths | works; removed on the next major |
| Internal | `./internal/*` | **no guarantee**, may change in any release |

`.` is the canonical entry — everything framework-free lives there. `./react`
and `./server` exist because React is a peer dependency and `./server` statically
imports `node:async_hooks`, respectively. The three `./genui*` entries carry the
optional Generative UI peers (`zod`, `@openuidev/lang-core`); `./genui/fence`
loads neither. `./wire-message-id` is the message-id mint alone — it has no
imports, so a server loads it without the root barrel; the root exports the same
names. `./capture-rules` holds the Kortix Capture constants (also at the root).
`./workspace-search` is isolated from the root on purpose. The 21 legacy subpaths
(`@kortix/sdk/projects-client`, `/turns`, `/files`, `/session`, `/event-stream`,
the zustand stores, …) are `@deprecated` aliases that still resolve — import from
the root instead. That the root really does cover all of them is asserted by
`src/root-canonical.test.ts`, not merely claimed here. `./internal/*` backs `apps/web`'s zustand stores and is not
reachable from `window.Kortix`; treat it as visible implementation detail, not
designed API.

---

## IN SCOPE — the agent product (what the SDK needs)

### 1. Auth / session token  ✅
Injection seam, not an endpoint. `configureKortix({ getToken })` → token on every request. `backendApi`, `backendApi.postStream` and `authenticatedFetch` all send through `send()` (`core/http/transport.ts`): one header policy (bearer, client surface, admin bypass, act-as), one default deadline, one 401 replay with a fresh token.

### 1b. Token validation helper (pasted-API-key UX)  ✅
`kortix.validateToken()` → `GET /v1/accounts/me`. Never throws — resolves
`{valid: boolean, identity?: AccountIdentity, error?: ApiError}`. Built for a
setup screen that needs to render "invalid token" inline instead of
try/catching every call.

### 1c. Mobile release policy  ✅
`kortix.mobileClientPolicy()` → `GET /v1/clients/mobile`. Public (no token): a mobile build reads it before login. Resolves `{minimum_version, store_url_ios, store_url_android}` (strings or `null`). `compareSemver(a, b)` compares versions.

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
| finalized LLM + compute cost | `GET /v1/usage/session-costs/:sid?project_id=:id` → `projects-client/session-costs.ts`, facade `session(pid,sid).cost()` ✅ |
| transcript | `GET .../sessions/:sid/transcript` → `projects-client/sessions.ts`'s `getSessionTranscript` ✅, facade `session(pid,sid).transcript()` ✅ (previously listed ✅ here with no client fn behind it — that was false; now genuinely wired) |
| preview candidates (live ports) | `GET .../sessions/:sid/previews` |
| public shares | `GET/POST/DELETE .../sessions/:sid/public-shares[/:id]` |
| public transcript share (`{ transcript: true }`, one live link per session; `findActiveTranscriptShare`) + anonymous read (`getPublicSessionShare`, `getPublicSessionShareMessages`, by `share_id` or `kps_` token) | `POST .../sessions/:sid/public-shares` · `GET /v1/public/session-shares/:ref[/messages]` |

### 5b. Token minting (CLI PATs) — Kortix-as-a-Backend-critical  ✅
| op | REST | SDK |
|---|---|---|
| list / create / revoke (account-scoped) | `GET/POST /v1/accounts/tokens`, `DELETE /v1/accounts/tokens/:tokenId` | `projects-client/tokens.ts` ✅, facade `kortix.accounts.tokens.{list,create,revoke}` ✅ |
| list / create / revoke (project-scoped, `KORTIX_TOKEN`) | `GET/POST /v1/projects/:id/cli-token`, `DELETE .../cli-token/:tokenId` | ✅, facade `project(id).tokens.{list,create,revoke}` ✅ |

### 6. Session runtime  ✅

`useSession(projectId, sessionId)` and `kortix.session(projectId, sessionId)`
open the session runtime returned by `POST /start`. Every new session runs pi
inside kortixd. Hosts call the session verbs below and never construct a
runtime route. A feature the runtime does not serve is a capability:
`GET /kortix/health` lists `capabilities`, and `runtimeSupports(caps, name)`
gates the control. pi lists `session.subagents`, `session.compact`,
`session.commands`, `session.steer` and `session.log.v2`; it does not list
`session.rewind`, `session.fork`, `session.mcp`, `session.todo`,
`session.shell`, `session.attach` or `session.config`.
| op | SDK |
|---|---|
| health + capabilities | `s.health()`, `runtimeSupports`, `useRuntimeSupports` |
| messages (Kortix transcript, `GET /kortix/runtime/messages`, at most 200 per page) | `s.messages({ limit })`, `useSession().messages` |
| **send prompt** (the durable inbox, `POST /v1/projects/:id/sessions/:sid/prompts`) | `s.send(text)`, `s.prompts.create(...)`, `useSession().send` |
| abort | `s.abort()` |
| **events (SSE)** | `s.stream({ onEvent })`, `openEventStream`, `useRuntimeEventStream` |
| pending permissions and questions | `s.pending()` |
| permission reply / question answer | `s.answerPermission(id, reply)`, `s.answerQuestion(id, answers)` |
| compact (`session.compact`) | `s.compact()` |
| rewind / restore (`session.rewind`) | `s.rewind(messageId)`, `s.restoreRewind()` |
| session log (`kortix.session/2`) | `s.log(query)`, `getSessionLogPage`, `useSessionLog`, `useSessionLogThread` |

### 7. Models / gateway  ✅
- picker models: `GET /v1/projects/:id/model-picker` (`kortix.projects.modelPicker`) → `pickerProviderList`, `flattenModels`, `useRuntimeProviders` ✅. Every model call goes through the Kortix LLM gateway.
- catalog/budget: `GET /v1/llm/models`, `GET /v1/projects/:id/llm-catalog`
- selection + persistence: `useRuntimeLocal`, `useModelStore` ✅
- **gateway observability** (`/v1/projects/:id/gateway/{overview,logs,keys,budgets,series,errors}`) → client fully in SDK (`projects-client/gateway.ts`) ✅; hooks still web-local 🟡
- **gateway playground** — `project(id).gateway.playground(prompt, models, system?)` → `POST /v1/projects/:id/gateway/playground` (run one prompt, plus an optional system prompt, against up to 6 models side by side) ✅; no React hook in the SDK

### 8. Agents · commands · tools · skills
| op | source | SDK |
|---|---|---|
| agents (roster, picker list, the agent to send) | project config (`GET /v1/projects/:id/detail`) | `projectConfigAgentsToRuntimeAgents`, `composerSelectableAgents`, `resolveComposerAgent`, `useRuntimeAgents` ✅ |
| commands list / run | session runtime, needs `session.commands` | `useRuntimeCommands` ✅ |
| tools | session runtime | `useRuntimeTools` ✅ |
| skills **list** | `GET /v1/projects/:id/detail` | `project(id).detail()` ✅ |
| skills **create / remove** | `POST /v1/projects/:id/skills`, `POST /v1/projects/:id/skills/remove` (a commit on the default branch) | `project(id).skills.{create,remove}` ✅ |

### 9. Terminal (PTY)  ✅
Kortix-native (`core/runtime/pty.ts`), independent of the agent runtime — daemon
`/kortix/pty` (`list/create/update/remove`) + `WS /kortix/pty/:id/connect?token=`
→ `getKortixPtyWebSocketUrl`. Hooks: `useRuntimePtyList`, `useCreatePty`,
`useRemovePty`, `useUpdatePty`, `getPtyWebSocketUrl`.

### 10. Workspace files  ✅ (client) · 🟡 (hooks)
Daemon-direct, full 12-op client in the SDK root (`core/files/client.ts`; the session handle binds it as `s.files.*`):
| op | daemon HTTP | SDK |
|---|---|---|
| list dir | `GET /file?path=` | ✅ `files.listFiles` |
| read text | `GET /file/content?path=` | ✅ `files.readFile` |
| read binary | `GET /file/raw?path=` | ✅ `files.readBlob` |
| git status | `GET /file/status` | ✅ `files.getFileStatus` |
| find files | `GET /find/file?query=&type=` (also `client.find.files`) | ✅ `files.findFiles` |
| ripgrep text | `GET /find?pattern=` | ✅ `files.findText` |
| upload / create / copy / delete / mkdir / rename | `POST /file/upload`, `POST /file/mkdir`, `POST /file/rename`, `DELETE /file` | ✅ `files.{uploadFile,createFile,copyFile,deleteFile,mkdir,renameFile}` |
| **overwrite in place** | `POST /file/upload` (temp name) → `POST /file/rename` (over target) | ✅ `files.writeFile` |

`writeFile` is the only op that overwrites. The daemon's upload writes with
`flag: 'wx'` and, on `EEXIST`, lands the bytes under a suffixed name
(`notes-mdx8k2-3f9a1c04.md`) — so `uploadFile` over an existing path writes a
DIFFERENT file and reports where it went. `writeFile` uploads to a temp name and
renames over the target (`fs.rename` overwrites atomically), backing the
original up and restoring it if the swap fails. Use it for every "save this
edited file" flow; `uploadFile` is for new files only.

`files.createFile` is built on `writeFile` for the same reason it is
version-safe: the daemon is baked into the sandbox image and `/v1/runtime-assets`
does **not** ship it, so an old daemon (which drops the filename of a 0-byte
multipart part) lands an empty create as `undefined`. Renaming the
daemon-REPORTED path onto the requested path makes both fleets correct. Do not
turn it back into a direct upload.
React hooks live in `@kortix/ui` (`packages/ui/src/files/runtime`), not in the SDK. `useWorkspaceSearch` (`packages/ui/src/files/runtime/hooks/use-workspace-search.ts`) is consumed by `apps/web/src/features/workspace/command-palette.tsx`.

### 11. Git / versions / change-requests  🟡
Client fns in SDK (`git-history.ts`, `change-requests.ts`), **hooks partial** (`useChangeRequests` in `@kortix/sdk/react` ✅; the rest of `packages/ui/src/files/project` is still web-local):
| op | REST |
|---|---|
| commits / commit / diff | `GET /v1/projects/:id/commits[/:sha][/diff]` |
| branches | `GET /v1/projects/:id/branches` |
| file history / version-diff | `GET /v1/projects/:id/files/history`, `/version-diff` |
| change-requests CRUD | `GET/POST/PUT /v1/projects/:id/change-requests[/:cr]`. The list is one page (default 50, at most 500): `listChangeRequests(id, status, { limit, cursor })` → `next_cursor` |
| review inbox | `GET /v1/projects/:id/review/items` (one page, default 50, at most 200: `listReviewItems(id, { segment, kind, sessionId, limit, cursor })`, `useReviewItemPages`), `GET .../review/summary` (needs-you counts: `getReviewSummary`, `useReviewSummary`, `project(id).review.summary()`) ✅ |
| merge / merge-preview / close / reopen | `POST .../change-requests/:cr/{merge,close,reopen}`, `GET .../merge-preview` |
| **request-changes** (Review Center feedback) | `POST .../change-requests/:cr/request-changes` → client fn already existed (`requestChangesOnChangeRequest`), now also on the facade: `project(id).changeRequests.requestChanges(crId, feedback)` ✅ |
| project files (git-backed) | `GET /v1/projects/:id/files`, `POST /files/{content,search}`, `GET /files/archive` |

### 12. Connectors and connections  ✅ (project) · 🟡 (connector)
- project Connector configuration, Connections, sharing, and policies →
  `projects-client/{connectors,policies}.ts` ✅
- Connector data plane → `project(id).connectors.{catalog,tools,search,describe,call,uploadAttachment}` ✅
- agent-token fallback → `kortix.connectors.{catalog,tools,search,describe,call,uploadAttachment}` ✅

### 13. Triggers / scheduled tasks  🟡
`projects-client/triggers.ts` ✅ (client) ; `useProjectTriggers` now in `@kortix/sdk/react` ✅ (list + create/update/remove/fire, invalidation-wired); the web app's own `hooks/scheduled-tasks` hook hasn't migrated onto it yet.

### 13b. Marketplace install (project-scoped)  ✅
A project installs a catalog item through a session: `createMarketplaceInstallSession(projectId, itemId)` → `POST /v1/projects/:id/marketplace/install-session` starts a session whose agent merges the item into the project and opens a change request; it resolves `{ session_id }` (`projects-client/marketplace-catalog.ts`). The project handle has no marketplace member. Browsing the catalog is §13c.

### 13c. Marketplace catalog browse (public) + sources  ✅
Previously OUT OF SCOPE ("Marketplace catalog browsing"). Now wrapped
end-to-end: client fns in `projects-client/marketplace-catalog.ts` are on the
facade as `kortix.marketplace.{items, item, itemFile, marketplaces, featured,
sources: {list, add, remove}}` (top-level; install is §13b):
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
  (validates a `kortix.yaml` manifest's raw text
  server-side, format auto-resolved from the project's manifest path; same
  schema `kortix ship`/`kortix validate`/the CR-merge gate use; always
  resolves with `{valid, issues}`, never throws on an invalid manifest).
- `project(id).gitToken()` → `POST /v1/projects/:id/git-token` (mints a
  fresh scoped git push token for a *managed* project; throws/409s for BYO
  repos).

### 14. Sandbox lifecycle  ✅ / 🟡
- session-sandbox status/metrics/instances → `projects-client/{sandbox,session-sandbox}.ts` ✅
- `GET /v1/projects/:id/{sandbox-health,sandboxes}`, snapshots, `GET /v1/platform/sandbox/version*` → 🟡 client in the SDK root ✅; hooks web-local (`hooks/platform`)
- sandbox proxy `ALL /v1/p/:externalId/:port/*` + preview auth/share → the base URL of every session runtime call ✅

### 15. Billing  ✅ (read + a curated mutation surface)
Read surface — `kortix.billing.{accountState, accountStateMinimal,
transactions, transactionsSummary, creditBreakdown, usageHistory, usageRollup,
sessionCosts, tierConfigurations}` ✅. Hooks still web-local
(`packages/ui/src/internal/billing`) 🟡.
| op | REST |
|---|---|
| account state (full / minimal) | `GET /v1/billing/account-state[/minimal]` |
| transactions (paginated) / summary | `GET /v1/billing/transactions`, `/transactions/summary` |
| credit breakdown | `GET /v1/billing/credit-breakdown` |
| usage history | `GET /v1/billing/usage-history` |
| unified session cost list / detail | `GET /v1/usage/session-costs`, `/v1/usage/session-costs/:sid` |
| tier configurations (public pricing) | `GET /v1/billing/tier-configurations` |

The unified session-cost client lives in `projects-client/session-costs.ts`.
Use `kortix.billing.sessionCosts.list(options)` for account or project
pagination. Use `kortix.billing.sessionCosts.get(sessionId, options)` for model
usage and mixed LLM/compute ledger entries.

Mutations — a deliberately curated subset of `apps/api/src/billing/routes`
(Stripe-webhook-only routes and retired per-seat internals stay
unwired) now live in `projects-client/billing.ts` and are grouped on the
facade as `kortix.billing.{setPlan, checkout, subscription, credits}`:
| group | op | REST |
|---|---|---|
| (top level) | setPlan | `POST /v1/billing/plan` (`useSetBillingPlan()` hook) |
| `checkout` | createSession | retired: rejects with `ENDPOINT_RETIRED` (API answers `410`) |
| `checkout` | confirmSession | retired: rejects with `ENDPOINT_RETIRED` (API answers `410`) |
| `subscription` | createPortalSession | `POST /v1/billing/create-portal-session` |
| `subscription` | cancel | `POST /v1/billing/cancel-subscription` |
| `subscription` | reactivate | `POST /v1/billing/reactivate-subscription` |
| `subscription` | scheduleDowngrade | retired: rejects with `ENDPOINT_RETIRED` (API answers `410`) |
| `subscription` | cancelScheduledChange | retired: rejects with `ENDPOINT_RETIRED` (API answers `410`) |
| `subscription` | prorationPreview | retired: rejects with `ENDPOINT_RETIRED` (API answers `410`) |
| `credits` | purchase | `POST /v1/billing/purchase-credits` |
| `credits` | autoTopupSettings | `GET /v1/billing/auto-topup/settings` |
| `credits` | configureAutoTopup | `POST /v1/billing/auto-topup/configure` |

### 16. Transcription / misc session input  🟡
`POST /v1/transcription` (voice) client now in SDK (`projects-client/transcription.ts`) ✅; hooks still web-local (`hooks/transcription`) 🟡.

### 17. Channels (project-scoped)  🟡
Slack and Teams installs live in `projects-client/channels.ts` (facade `project(id).channels.{slack,teams}`); hooks remain web-local.
Also now wrapped: Slack file download/upload proxies
(`project(id).channels.slack.{getFile, uploadFile}` →
`GET/POST /v1/projects/:id/channels/slack/file[/upload]`).

Telegram: facade `project(id).channels.telegram.*`; hooks live in `@kortix/ui` (`internal/hooks/channels/use-channels-installations.ts`).
| op | function | REST |
|---|---|---|
| `installation` (`access_request_count`) | `getTelegramInstallation` | `GET /v1/projects/:id/channels/telegram/installation` |
| `connect` | `connectTelegram` | `POST .../channels/telegram/connect` |
| `setAllowedUsers` (replace list) | `setTelegramAllowedUsers` | `PUT .../channels/telegram/allowed-users` |
| `disconnect` | `disconnectTelegram` | `DELETE .../channels/telegram` |
| `users` (`{allowed, requests}`) | `listTelegramUsers` | `GET .../channels/telegram/users` |
| `allowUser` | `allowTelegramUser` | `POST .../channels/telegram/allowed-users` `{user_id}` |
| `removeUser` | `removeTelegramUser` | `DELETE .../channels/telegram/allowed-users/:userId` |
| `dismissAccessRequest` | `dismissTelegramAccessRequest` | `DELETE .../channels/telegram/access-requests/:userId` |
| `userPhoto` (JPEG `Blob`, 404 → `null`) | `getTelegramUserPhoto` | `GET .../channels/telegram/users/:userId/photo?v=` |

### 18. Account audit log (Enterprise)  ✅ (client + facade) / 🟡 (hooks)
Event list + CSV/JSONL export + outbound SIEM webhook CRUD, gated server-side on `audit.read`/`account.write` + the account's `auditAccess` entitlement. `projects-client/audit.ts` ✅; facade `kortix.accounts.audit.{log, export, webhooks: {list,create,update,remove}}` ✅ (accountId-first, like the rest of `kortix.accounts.*`); no hooks yet (this is an admin-console surface, low priority for the agent-product hooks):
| op | REST |
|---|---|
| list events (cursor-paginated) | `GET /v1/accounts/:id/audit` |
| export (CSV/JSONL) | `GET /v1/accounts/:id/audit/export` |
| webhooks CRUD | `GET/POST /v1/accounts/:id/audit/webhooks`, `PATCH/DELETE .../:webhookId` |

### 19. Native push and presence (per user)  ✅ (client + facade)
A native app registers its push token; a session push reaches the phone of the person who created the session. `projects-client/notifications.ts` + `sessions.ts` ✅; facade `kortix.notifications.{registerDeviceToken, unregisterDeviceToken, releaseDeviceToken}` and `session(pid, sid).presence` ✅. Every route needs a person's credential, except the release, which a signed-out app calls.
| op | REST |
|---|---|
| native push token | `POST /v1/notifications/device-token`, `DELETE .../device-token/:token` |
| release a token after sign-out (no credential) | `POST /v1/notifications/device-token/release` |
| presence lease (a 90 s lease per tab; holds back the phone push, and keeps the computer on until `awake_cap_at`, at most the idle window after the latest turn) | `PUT /v1/projects/:id/sessions/:sid/presence` |

---

## OUT OF SCOPE — control plane / platform admin (NOT the SDK)
Map exists, but these belong to the platform app, not the agent SDK:
- **Accounts IAM v2** — groups, service-accounts, SCIM tokens, SSO/SAML, session/MFA/PAT policy (`/v1/accounts/:id/iam/*`, `/scim/v2/*`). (Account **audit** — event log, export, SIEM webhooks — is now IN SCOPE, see §18; it's the one IAM-v2-adjacent surface the SDK wraps because a "Kortix as a Backend" host needs to read its own compliance trail.)
- **Admin console** — tiers, credits debit, provider analytics/distribution/fallback, snapshot config (`/v1/admin/*`)
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
| Session runtime (messages/events/permissions/questions) | ✅ complete |
| Models, Agents, Commands, Tools, PTY | ✅ complete |
| **Workspace files (read/write/status/search)** | ✅ full client in the SDK root; hooks in `@kortix/ui` |
| Token minting (account + project-scoped CLI PATs) | ✅ complete — `projects-client/tokens.ts`, facade `kortix.accounts.tokens.*` / `project(id).tokens.*` |
| Marketplace install (project-scoped) | ✅ complete — `createMarketplaceInstallSession` (`projects-client/marketplace-catalog.ts`); no project-handle member |
| Public marketplace catalog browse + sources | ✅ complete — `projects-client/marketplace-catalog.ts`, facade `kortix.marketplace.*` |
| Billing mutations (checkout/subscription/credits) | ✅ complete — `projects-client/billing.ts`, facade `kortix.billing.{checkout, subscription, credits}` |
| Unified session costs | ✅ complete — `projects-client/session-costs.ts`, facade `kortix.billing.sessionCosts.{list,get}` / `session(pid,sid).cost()` |
| Setup links, manifest validate, git token | ✅ complete — facade `project(id).{setupLinks, validateManifest, gitToken}` |
| Account audit (Enterprise) | ✅ client + facade (`kortix.accounts.audit.*`); 🟡 no hooks yet |
| Skills create / remove | ✅ complete — `project(id).skills.{create,remove}` |
| Git / versions / change-requests, gateway observability, sandbox-admin, billing/account-state, transcription | 🟡 client fns ✅ in SDK, hooks still web-local |
| Channels (Slack and Teams installs) | 🟡 client fns ✅ in SDK, hooks still web-local — also the Slack file get/upload proxy (client + facade wired; see §17) |
| Triggers, project secrets, change-requests | 🟡→partial ✅ — `useProjectTriggers`/`useProjectSecrets`/`useChangeRequests` now in `@kortix/sdk/react`; the pre-existing web hooks for these haven't migrated onto them yet |
| Connector runtime | 🟡 web-local |
| kortix-master daemon family (tasks/tickets/projects/milestones/credentials/services) | ⚠️ **Deprecated**: the sandbox daemon serves none of these routes, so every call answers 404. Client in the SDK root (`core/runtime/kortix-master.ts`) + hooks in `@kortix/sdk/react` (`use-kortix-master.ts`) |

### To make the SDK the whole data layer
1. ~~Add a `files` client to the SDK~~ — **done**: the root entry wraps the daemon `/file` + `/find` endpoints (12 ops). Remaining: move `packages/ui/src/files/runtime` hooks in; **collapse the `packages/ui/src/files/project` twin** into it (backend-parameterized).
2. **Wrap the existing client fns as hooks** in the SDK: git/versions/change-requests (`useChangeRequests` ✅ done; commits/branches/diff still web-local), triggers (`useProjectTriggers` ✅ done), gateway-observability, sandbox-admin, billing/account-state.
3. ~~Framework-free event stream~~ — **done**: `openEventStream` (`@kortix/sdk` root barrel) is a framework-free connect/reconnect/heartbeat/coalescing primitive with zero React deps, and `session.stream()` is a thin facade over it (`ensureReady()` + the session's own runtime URL). `@kortix/sdk/react`'s `useRuntimeEventStream` is a React wrapper around the same primitive — a non-React host (server wrapper, worker, CLI) subscribes directly via `session.stream()` or `openEventStream()`.
4. ~~Land + export the kortix-master daemon client~~ — **done**, and deprecated since: the daemon serves none of its routes (see the coverage table).
5. **Mobile adoption** — the SDK is the shared implementation in principle, but the mobile app hasn't migrated its data layer onto it yet.
6. Everything else (the agent loop) is already SDK — that's the verified path.
