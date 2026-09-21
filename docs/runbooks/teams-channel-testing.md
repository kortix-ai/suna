# Microsoft Teams channel — end-to-end test runbook

Scope: the per-project `teams` feature flag (Settings → Feature flags →
"Microsoft Teams"). Code: `apps/api/src/channels/teams/*`,
`apps/api/src/channels/teams-*.ts`, `apps/api/src/projects/routes/r4.ts`
(`/channels/teams/*`), `apps/web/.../channels-view.tsx`,
`teams-channel-panel.tsx`, `apps/cli/src/commands/channels.ts`,
sandbox CLI `apps/sandbox/slack-cli/channels/teams.ts`, agent skill
`packages/starter/templates/managed/.kortix/opencode/skills/kortix-teams/SKILL.md`.

Last verified against `main` @ `786880d9a2` (2026-09-17). Unit baseline:
`bun test --isolate --env-file=scripts/test.env src/__tests__/unit-teams-*.test.ts src/__tests__/unit-channel-materialize-teams-flag.test.ts`
→ 60 pass / 0 fail across 13 files.

---

## 0. How it works (what you are testing)

| Piece | Behavior |
|---|---|
| Gate | Per-project flag `teams` (default off, experimental). Server creds `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD` decide only whether the **managed** install path is offered (`teamsMode().available`). |
| Install modes | **Managed one-click**: tenant admin opens `orgConsentUrl` → `/v1/webhooks/teams/oauth/callback` → saves install (tenant id) → publishes the app package to the org catalog via Graph (delegated `AppCatalog.ReadWrite.All`, 120 s budget, runs in the background) → redirects to the Channels page `/projects/:id/customize/connectors?scope=channels&teams=connected\|review\|failed\|publishing\|declined\|disabled\|unconfigured` (`/?teams_error=expired` on bad state). The browser waits at most 8 s for the publish; `publishing` means it is still running and the row polls every 3 s. The outcome is persisted on the install as `publishState` (`publishing\|published\|review\|failed`) + `publishError` (the Graph reason). **Managed manual**: `GET /channels/teams/manifest` → zip + icons → upload in Teams → `POST /channels/teams/connect {tenant_id, team_name}`. **BYO bot**: `POST /connect {tenant_id, app_id, app_password}`; messaging endpoint becomes `/v1/webhooks/teams/:projectId/messages`. |
| Inbound auth | Every activity carries a Bot Framework JWT. Verified against `MICROSOFT_BOT_OPENID_METADATA` JWKS, issuer `api.botframework.com`/`.us`, audience = app id, `serviceurl` claim must equal `activity.serviceUrl`. No creds → 503. Bad/missing token → 401. BYO route with flag off → plain 404. |
| Dedup | `chat_event_dedup` keyed `teams:event:<activity.id>` (5 min). |
| Project resolution | `chat_channel_bindings` (tenant + conversation) → else first `chat_installs` row for the tenant. |
| Identity | `TEAMS_REQUIRE_USER_IDENTITY=true` (default): sender (`from.aadObjectId`) must be linked in `chat_user_identities`, be an account member, and hold `project.write`. Unlinked → "Connect your Kortix account" card with a 10-min signed link; the message is parked in `chat_pending_auth_messages` and replayed after bind. Linked but no access → "Request access" card → `project_access_requests` row + manager notification. `=false` → runs as the project automation actor. |
| Commands | `/login /connect /logout /disconnect /whoami /who /help /status /config /settings /models /model <ref\|default> /agents /agent <name\|default> /projects /use <name\|id> /switch`. Anything else starting with `/` is NOT a command and starts a session. |
| Channels and mentions | Personal chat: every message reaches the bot. Channel / group chat: Teams delivers @-mentions; with the manifest's RSC permission `ChannelMessage.Read.Group` (manifest 1.1.0, consented by the team owner when the app is added/updated on the team) it delivers every channel message. An **un-mentioned** channel message is handled only as a follow-up in a thread that already has a session (`chat_threads` row); otherwise it is ignored and never runs a command. `<at>…</at>` mention markup is stripped from the title source, the agent prompt, and the web display. |
| Card body | The `teams send` markdown is converted to card elements (`teams/markdown.ts`): fenced code → Monospace TextBlock, inline code → bold, headings → sized text, pipe tables → Table, `>` → subtle, `---` → separator. |
| First card | Posted right after the project row (before identity/membership/thread lookups); an identity failure REPLACES it in place. Typing + card in parallel; bot token prewarmed at boot and every 50 min. Log line `[teams-webhook] live card posted {ms}`. |
| Catalog upgrade | Re-consenting (Channels row → "Publish to your Teams catalog", shown for any managed install not mid-publish) on an app already in the catalog submits the package as a new app definition (`POST /appCatalogs/teamsApps/{id}/appDefinitions`, result `updated:true`). |
| Session | First message in a conversation → `createSession(source:'teams')` with `agent_name`/`opencode_model` from the conversation selection, bound in `chat_threads`. Later messages in the same conversation → `continueSession`. Live "Working on it…" Adaptive Card + typing indicator posted before the session starts. `teams step` repaints it; `teams send` finalizes ("Task complete" + session link). Stale open turn (30 min no update) → "_This run ended without a reply._". |
| Start errors | 402 → out of credits copy; 429 → cap copy; 404 → project gone copy; other → generic; queued/pending → queued copy. |
| Card actions (invoke `adaptiveCard/action`) | `teams_set_model`, `teams_set_agent`, `teams_pick_project`, `teams_answer` (question tool), `teams_review` (approve/changes/reject), `teams_request_access`. |
| Files | Inbound attachments (`file.download.info`) are listed in the prompt; agent runs `teams download --url --out` through `GET /channels/teams/file?url=` (allowlist: sharepoint.com, sharepoint-df.com, svc.ms, microsoft.com, office.com; Graph host gets an app token). Outbound `teams send --file` → `POST /channels/teams/file/upload` (≤ 4 MB, 15-min TTL) → consent card → accept → PUT to `uploadInfo.uploadUrl` → file-info card. |
| Connector | `kortix_teams` connector materialized when install exists AND flag on. Graph app-only reads: `get_team`, `list_channels`, `get_channel`, `list_members`, `get_user`, `list_teams`, `list_messages`, `get_message`, `list_replies`. |
| Outbound safety | Bot token only sent to hosts matching `botframework.com`, `botframework.us`, `trafficmanager.net`, `azurewebsites.net`. |
| Disconnect | `DELETE /channels/teams/installation` removes the `MS_TEAMS_*` project secrets + `chat_installs` row and re-reconciles connectors. |

**Bot Framework Emulator does not work** (issuer + serviceUrl allowlists). A
real Teams tenant is mandatory for anything past the 401/503 boundary.

---

## 1. Microsoft side — what you need

### 1.1 Tenants and users

1. **A Microsoft 365 tenant with Teams licenses** (Business Basic trial is
   enough). The Entra-only SSO test tenant (`kortixssotest.onmicrosoft.com`) has
   no Teams unless you add a Teams-bearing license.
2. **Users in that tenant:**
   - **User A** — Teams admin + Global admin (needed for admin consent and
     catalog publish). Also a Kortix project owner.
   - **User B** — normal tenant user, has a Kortix account that is a member of
     the account but has NO access to the test project (for `not_member`).
   - **User C** — normal tenant user with NO Kortix account (for `unlinked`).
3. **Teams admin center** → Teams apps → Setup policies: allow "Upload custom
   apps" for User A (manual/BYO path). Org-wide app settings → allow custom apps.
4. Record the **tenant id** (Entra → Overview → Tenant ID). Connect accepts a
   GUID or a domain like `contoso.onmicrosoft.com`.

### 1.2 Bot app registration (managed path)

Dev already has one: `MICROSOFT_APP_ID=62b4470a-…` in `apps/api/.env.dev`,
`MICROSOFT_APP_TENANT=435431f6-fc5c-4d3e-8d99-9ff939fec417`,
`TEAMS_APP_NAME="Kortix Dev"`. For **local** you need a second registration
(or reuse dev's creds in `apps/api/.env.local` — then the same bot can only
point at one messaging endpoint at a time).

Per registration, in Entra → App registrations:

1. **Supported account types:** "Accounts in any organizational directory"
   (multi-tenant). If single-tenant, the bot only works inside that one tenant
   and `MICROSOFT_APP_TENANT` must be that tenant id.
2. **Certificates & secrets:** client secret → this is
   `MICROSOFT_APP_PASSWORD`. Note the expiry; an expired secret makes every
   outbound send fail with `Teams token request failed (401)`.
3. **Authentication → Web redirect URI:**
   `https://<API_PUBLIC_BASE>/v1/webhooks/teams/oauth/callback`
   (one per API base you test: dev-api, your tunnel). Missing → one-click
   install fails with `AADSTS50011` and Kortix redirects `?teams=declined`.
4. **API permissions:**
   - Delegated: `openid`, `offline_access`, `AppCatalog.ReadWrite.All`
     (one-click publish).
   - Application (Graph, for the `kortix_teams` connector reads):
     `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `TeamMember.Read.All`,
     `User.Read.All`, `Files.Read.All`.
     `ChannelMessage.Read.All` (app-only) is a **protected API**: without
     Microsoft approval `list_messages` / `get_message` / `list_replies` return
     403. Expect that and record it.
   - Click **Grant admin consent** for the home tenant. Customer tenants grant
     via the `adminConsentUrl` Kortix prints.
5. **Azure Bot resource** (Azure portal → Create → Azure Bot):
   - Type: Multi Tenant, "Use existing app registration" with the app id.
   - Configuration → **Messaging endpoint**:
     `https://<API_PUBLIC_BASE>/v1/webhooks/teams/messages`.
   - Channels → add **Microsoft Teams** (accept terms).
6. **BYO bot** (for the BYO test): a second app registration + Azure Bot
   whose messaging endpoint is
   `https://<API_PUBLIC_BASE>/v1/webhooks/teams/<projectId>/messages`.

### 1.3 Which API base

| Target | API base | Notes |
|---|---|---|
| dev | `https://dev-api.kortix.com` | Creds already deployed. Verify in Azure that bot `62b4470a-…` points here and its Teams channel is enabled. |
| local | cloudflared quick tunnel from `pnpm dev` | URL changes every run → edit the Azure Bot messaging endpoint + redirect URI after each `pnpm dev`. `scripts/dev-local.sh` only honours a pre-set `KORTIX_URL` if `/health` already answers, so a static domain needs the API up before the script probes it. |

---

## 2. Kortix side — what you need

### 2.1 Server env

- dev: already set (see above). `TEAMS_CHANNEL_ENABLED=true` in `.env.dev` is
  **dead** — `config.ts` no longer reads it; the gate is the project flag.
- local: `apps/api/.env` has no Microsoft vars. Put plaintext overrides in the
  gitignored `apps/api/.env.local`:
  ```
  MICROSOFT_APP_ID=<app id>
  MICROSOFT_APP_PASSWORD=<secret>
  MICROSOFT_APP_TENANT=botframework.com   # or your tenant id for single-tenant
  TEAMS_APP_NAME=Kortix Local
  # TEAMS_REQUIRE_USER_IDENTITY=false      # only for test F.9
  ```
  `FRONTEND_URL` must be the URL the Teams user can open (`http://localhost:3000`
  works when Teams runs on the same machine). `KORTIX_URL` is set by the tunnel.

### 2.2 Data

- **Account X** with two projects: **P1** (the main one) and **P2** (for
  `/projects` and `/use`). P1's repo declares ≥ 2 agents in `kortix.yaml` so
  `/agents` has options. P1 has credits.
- **P3** in another account with the flag on, for cross-account negatives.
- Users: User A = owner of X. User B = member of X without P1 access (custom
  role or no project grant). User C = no Kortix account.
- Turn `teams` on for P1 (and P2): Settings → Feature flags → "Microsoft
  Teams", or:
  ```bash
  kortix projects features enable teams --project <P1>
  ```
  (API: `PATCH /v1/projects/:id/experimental {"feature":"teams","enabled":true}`.)

### 2.3 Local read-back

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres
```
Tables: `chat_installs`, `chat_channel_bindings`, `chat_threads`,
`chat_user_identities`, `chat_turn_streams`, `chat_pending_auth_messages`,
`chat_event_dedup`, `teams_pending_uploads`, `project_secrets` (names
`MS_TEAMS_*`), `project_access_requests`.

### 2.4 Automated baseline (run first, must be green)

```bash
# apps/api unit suite for Teams (60 tests)
cd apps/api && bun test --isolate --env-file=scripts/test.env src/__tests__/unit-teams-*.test.ts src/__tests__/unit-channel-materialize-teams-flag.test.ts
# REST flows CHN-T1..T4 (installation read ACL, mode ACL, connect validation + flag gate, webhook 401/503)
pnpm test -- --id CHN-T1 && pnpm test -- --id CHN-T2 && pnpm test -- --id CHN-T3 && pnpm test -- --id CHN-T4
# CLI unit
cd apps/cli && bun test src/__tests__/channels.test.ts
# web
cd apps/web && bun test src/features/workspace/customize/sections/channels-view.test.ts
```

---

## 3. Test cases

Format: **ID — action → expected. Proof.** Do every case on local first, then
repeat the "dev" column on `https://dev.kortix.com` for the ones marked ★.

### A. Flag gating

| ID | Action | Expected | Proof |
|---|---|---|---|
| A1 ★ | Flag off; open project → Channels | No Teams row, no "Use your own Microsoft Teams app" panel | DOM |
| A2 ★ | `GET /v1/projects/P1/channels/teams/mode` with flag off | 200, `enabled:false, available:false, orgConsentUrl:null` | curl |
| A3 | `POST …/channels/teams/connect` flag off | 403 `{code:"feature_disabled", feature:"teams"}` | CHN-T3 |
| A4 | `POST …/channels/teams/file/upload` flag off | 403 `feature_disabled` | curl |
| A5 | Toggle flag on | Row + panel appear without reload; `mode.enabled:true` | DOM + network |
| A6 | Flag on, no server creds (local without `.env.local`) | `mode.available:false`; panel shows "not configured" banner and BYO fields only; `GET …/manifest` → 409 | DOM + curl |
| A7 | Flag on, creds set | `mode.available:true, appId, messagingEndpoint=…/v1/webhooks/teams/messages, adminConsentUrl, orgConsentUrl` present | curl |
| A8 | Connected, then flag off | Row hidden; inbound message ignored with log `teams feature is off for project`; `DELETE …/installation` still works (cleanup allowed) | API log + curl |
| A9 | Flag toggled on/off | `kortix_teams` connector appears/disappears in Connectors (reconcile) | Connectors page / `GET /v1/projects/P1/connectors` |

### B. Install — managed one-click ★

| ID | Action | Expected | Proof |
|---|---|---|---|
| B1 | Click "Add to Teams" (row button = `orgConsentUrl`) as User A (Teams admin) → consent | Redirect to the Channels page with `?teams=connected` (or `?teams=publishing` if Graph took > 8 s, then the row badge "Publishing…" resolves by itself within ~2 min); toast; row shows tenant; "Open in Teams" button (deep link `teams.microsoft.com/l/app/<catalogAppId>`); app visible in Teams → Apps → Built for your org | `chat_installs` row platform=teams workspace_id=<tenant>; secrets `MS_TEAMS_TENANT_ID`, `MS_TEAMS_ORG_INSTALLED=1`, `MS_TEAMS_CATALOG_APP_ID`, `MS_TEAMS_PUBLISH_STATE=published`; `GET …/channels/teams/installation` → `publishState:"published"`; API log `[teams-oauth] install complete status=connected` |
| B1b | Graph rejects the package or times out | `?teams=failed`; toast; row badge "Catalog publish failed" with the Graph reason under the row; **Retry** button re-opens the consent URL | `MS_TEAMS_PUBLISH_STATE=failed`, `MS_TEAMS_PUBLISH_ERROR=<reason>`; `kortix channels status --platform teams` prints the reason |
| B2 | Same as B1 but as a non-admin tenant user | `?teams=review` (package submitted for admin review); install saved; badge "Waiting for a Teams admin to approve the app"; `orgInstalled:false`; no deep link | log `status=review`; `publishState:"review"` |
| B3 | Decline consent | `?teams=declined`; no install row | DB |
| B4 | Open `orgConsentUrl`, wait > 10 min, then consent | `/?teams_error=expired` | browser |
| B5 | Tamper `state` query param | `/?teams_error=expired` | browser |
| B6 | Consent for P1 while flag was turned off mid-flow | `?teams=disabled`, no install | DB |
| B7 | Redirect URI not registered in Entra | Microsoft error page `AADSTS50011` — record that this is the symptom | screenshot |
| B8 | Repeat B1 (already published) | Graph 409 path → still `connected`, catalog id re-looked-up | log |
| B9 | `kortix channels connect --platform teams` | Prints the same admin-consent URL; `kortix channels status --platform teams` → tenant + catalog app id | stdout |

### C. Install — managed manual + BYO + disconnect

| ID | Action | Expected | Proof |
|---|---|---|---|
| C1 | Open the "Use your own Microsoft Teams app" panel, copy manifest, zip with `color.png`/`outline.png`, upload in Teams (Apps → Manage your apps → Upload) | Teams accepts; manifest `id` = app id, `validDomains` = API host, `bots[0].scopes` = personal/team/groupchat, 6 commands in the command menu | Teams UI |
| C2 | Paste tenant id + team name → Connect | 200 summary; row connected with team name; `MS_TEAMS_TEAM_NAME` secret | DB |
| C3 | `tenant_id` = `"not a tenant"` | 400 tenant_id message | curl |
| C4 | `tenant_id` = `contoso.onmicrosoft.com` (domain form) | 200 | curl |
| C5 | `app_id` without `app_password` (and vice versa) | 400 "must be provided together" | curl |
| C6 | `app_id` not a GUID | 400 | curl |
| C7 | BYO: toggle "bring your own", enter app id + secret + tenant | 200; `mode.byo:true`, `messagingEndpoint=…/v1/webhooks/teams/<P1>/messages`, `orgConsentUrl:null`; `GET …/manifest` renders with the BYO app id | curl |
| C8 | BYO bot messaging endpoint pointed at `/v1/webhooks/teams/<P1>/messages`; send a message | Handled (JWT audience = BYO app id) | Teams reply |
| C9 | Message to BYO endpoint of a project with flag off | 404 `{error:"Not found"}` (never `feature_disabled`) | curl with any body |
| C10 | BYO endpoint of a project with no BYO app id | 503 "teams not configured for this project" | curl |
| C11 | Disconnect (row → Disconnect → confirm) | Toast; row back to "Add to Teams"; all `MS_TEAMS_*` secrets and `chat_installs` row gone; `kortix_teams` connector removed; a new inbound message is ignored (`no project installed for tenant`) | DB + log |
| C12 | `kortix channels disconnect --platform teams` | Same as C11 (note: the `kortix-teams` skill text claims disconnect is Slack-only — that text is stale) | stdout + DB |
| C13 | ACL: viewer / member without `project.connector.write` calls connect, disconnect, file/upload | 403; installation + mode GET still 200 for any member | curl |
| C14 | ACL: non-member / anon | 403 or 404 / 401 | CHN-T1..T3 |

### D. Webhook auth and dedup

| ID | Action | Expected | Proof |
|---|---|---|---|
| D1 | `POST /v1/webhooks/teams/messages` with no creds on server | 503 `teams not configured` | curl |
| D2 | Creds set, no `Authorization` | 401 | curl |
| D3 | `Authorization: Bearer garbage` | 401 + log `inbound activity token rejected` | curl + log |
| D4 | Non-JSON body | 400 `invalid activity payload` | curl |
| D5 | Real Teams message | 200 (empty body) within < 1 s; work continues async | API log `Request completed` |
| D6 | Replay: capture a real activity (log body + auth header on local), POST it twice within 5 min | Second POST → 200 but no second session/turn (`chat_event_dedup` hit) | DB count |
| D7 | Replay with a serviceUrl different from the JWT `serviceurl` claim | 401 | curl |

### E. Welcome card

| ID | Action | Expected |
|---|---|---|
| E1 | Add the app in a **personal** chat | "👋 Kortix is connected here" card with "Open in Kortix" → `/projects/P1` |
| E2 | Add the bot to a **group chat** | Same card, once (`welcome:<conversationId>` dedup) |
| E3 | Add the app to a **team channel** | Same card in the channel |
| E4 | Add the bot in a tenant with no install | Nothing posted, log `no project installed` |
| E5 | Remove and re-add the bot in the same conversation within 5 min | No second card (dedup TTL) |
| E6 | Channel: `@Kortix Dev summarize the README` | New session (channel post = its own conversation); live card, then the answer as a thread reply; session title has no `<at>` markup |
| E7 | Reply in that thread WITHOUT a mention (RSC consented on the team) | Same session continues (follow-up); without RSC consent Teams never delivers it |
| E8 | New channel post without a mention | Ignored (no session, no command), even `/help` |
| E9 | Reply `/status` in an owned thread without a mention | Delivered as text to the session, not run as a command |

### F. Identity (linking)

| ID | Action | Expected | Proof |
|---|---|---|---|
| F1 | User C (no Kortix account) sends "hello" | "🔗 Connect your Kortix account" card; no session | `chat_pending_auth_messages` row; no `chat_threads` |
| F2 | Click "Connect or create account" → sign up → bind | Page says linked; `resumed:true`; the parked "hello" starts a session and the live card appears in Teams | `chat_user_identities` row; `chat_threads` row |
| F3 | Same link opened twice | Second bind → 410 "invalid or has expired" (state consumed? — if not, both succeed; record actual) | network |
| F4 | Wait > 10 min then click the link | 410 | network |
| F5 | Bind by a user whose tenant has no install | 403 "not connected to any Kortix project" | network |
| F6 | User B (linked, member, no P1 access) sends a message | "🔒 Request access" card; tap → "Access requested"; `project_access_requests` row; owner gets the manager notification; tap again → same "Access requested" (pending) | DB + email/notification |
| F7 | Owner approves in Kortix; User B resends | Session starts | Teams |
| F8 | `/whoami` linked → "Connected as <email>"; `/logout` → "Disconnected"; `/whoami` → connect card; `/logout` again → "You weren't connected."; `/login` → connect card; re-bind → `revoked_at` cleared | DB |
| F9 | `TEAMS_REQUIRE_USER_IDENTITY=false` (local only) | User C's message starts a session as the automation actor; `POST /v1/channels/teams/identity/bind` → 404 | DB session `user_id` |
| F10 | `GET /v1/channels/teams/identity/login/<anything>` | 200 HTML redirect to `<FRONTEND_URL>/teams/login/<token>` | curl |
| F11 | Anonymous `POST /v1/channels/teams/identity/bind` | 401 | curl |

### G. Commands (send each as User A in a bound conversation)

| ID | Command | Expected |
|---|---|---|
| G1 | `/help` | Help card listing 8 commands |
| G2 | `/status`, `/config`, `/settings` | Panel: Project = P1 name, Agent = default, Model = project default, link to project |
| G3 | `/models` (P1 with LLM gateway ON) | Select card "Project default" + up to 6 models; tap one → "Model set to …" (`chat_channel_bindings` / selection row updated) |
| G4 | `/models` (P2 with LLM gateway OFF) | Notice card about native OpenCode models |
| G5 | `/model anthropic/claude-sonnet-4-6` (gateway on, servable) | "Model set to …. New sessions will use it." |
| G6 | `/model not/a-model` | "isn't available here" (gateway on) / "isn't usable here" (gateway off) |
| G7 | `/model default` | "Model reset to the project default." |
| G8 | `/agents` (P1 with declared agents) | Select card "Default" + agents; tap → "Agent set to X" |
| G9 | `/agents` on a project with no declared agents | "no declared agents" notice |
| G10 | `/agent nope` | "isn't a declared agent" |
| G11 | `/agent default` | reset notice |
| G12 | `/projects` | Select card listing P1 + P2 (same tenant); tap P2 → "now runs the selected project"; `/status` → P2 |
| G13 | `/use P1` / `/use <P1 id>` / `/switch P1` | "This conversation now runs *P1*" |
| G14 | `/use unknown` | Falls back to the projects card |
| G15 | `/foo` | NOT a command → starts a session with text "/foo" (confirm this is the intended behavior) |
| G16 | `@Kortix /help` in a channel | Mention stripped, help card |
| G17 | Command error (e.g. DB down) | "Something went wrong running that command" notice |
| G18 | `/whoami`, `/who` | Same as F8 |

### H. Session lifecycle ★

| ID | Action | Expected | Proof |
|---|---|---|---|
| H1 | First message "Summarize this repo's README" | Typing indicator, then a "Working on it…" card immediately; session appears in Kortix with `source=teams`, title from the message text, visibility project | `chat_threads` row; `chat_turn_streams` row `channel_ref.platform=teams` |
| H2 | Agent runs `teams step "Reading README" --detail "…"` | Card repaints in place with the step in progress | Teams |
| H3 | Second step with `--output "…"` | Previous step marked complete with output; new step in progress | Teams |
| H4 | `teams send "Done: …"` | Card becomes "Task complete" with steps + body + "Open session" link; `chat_turn_streams` row deleted | DB |
| H5 | Follow-up message in the same conversation | New live card; delivered via `continueSession` to the same session (no new `chat_threads` row); prompt starts "New message from <name> in the same Teams conversation" | Session transcript |
| H6 | Message in a different conversation (another chat/channel) | New session | DB |
| H7 | Two users send at the same time in a fresh conversation | One session; second message delivered as a follow-up (claim + 8 s wait) | DB: one `chat_threads` row; log has no "lost thread-create claim" |
| H8 | Follow-up after the session was stopped/idled | Session resumes and answers (record start latency) | Teams |
| H9 | Agent turn errors (kill the sandbox mid-turn, or `opencode` error) | "Run failed" card with classified copy | Teams |
| H10 | Agent never calls `teams send`, turn ends idle | Card finalized with empty body (`relayTurnEnd idle`) | Teams |
| H11 | Open turn with no update for 30 min | GC posts "_This run ended without a reply._" and deletes the row | DB + Teams |
| H12 | Model/agent selection set via G5/G8, then a NEW conversation | Session created with `opencode_model` / `agent_name` from the selection | Session metadata |
| H13 | `teams send` with 12,000-char text | Body truncated to 11,000 | Teams |
| H14 | `teams send` from a sandbox whose session has no open turn | CLI error "No active Teams turn to answer." exit ≠ 0 | sandbox shell |

### I. Session start errors

| ID | Setup | Expected card |
|---|---|---|
| I1 | Account with 0 credits (`KORTIX_BILLING_INTERNAL_ENABLED=true` locally) | "out of credits" copy |
| I2 | Account at concurrent-session cap | Either "queued … slot frees up" (queue policy) or the 429 copy — record which |
| I3 | Project deleted between bind and message | 404 copy "couldn't find this project" |
| I4 | Sandbox provider down | Generic "couldn't start a session just now" |

### J. Questions (question tool)

| ID | Action | Expected |
|---|---|---|
| J1 | Ask the agent something that makes it ask back with options (e.g. "Pick a color for me, ask me first") | Live card finalized; "💬 A quick question" card with option buttons |
| J2 | Tap an option | Notice "Answer received: X"; a new turn starts in the same session with that text |
| J3 | Reply in chat instead | Normal follow-up turn |
| J4 | Question with > 6 options / duplicate labels | Max 6 buttons, duplicates collapsed |

### K. Review center (approvals)

| ID | Action | Expected | Proof |
|---|---|---|---|
| K1 | Agent creates a review item (`require_approval` / change request) | "📝 <title>" card with risk badge, Approve / Request changes / Deny / View in Kortix | Teams |
| K2 | Approve as User A | Notice "Approved … resuming the agent"; Review Center item = approved by User A; agent resumes | Review page |
| K3 | Request changes | Item = changes requested; agent turn text says to ask what to change | Review page |
| K4 | Deny | Item rejected; agent told not to proceed | Review page |
| K5 | Tap as User C (unlinked) | "Connect your Kortix account (`/login`) to act on reviews." | Teams |
| K6 | Tap after the item was already decided in the web | "no longer exists" or applies second verdict — record actual | Review page |

### L. Files

| ID | Action | Expected | Proof |
|---|---|---|---|
| L1 | Personal chat: attach a file + "Summarize this" | Prompt contains "Attached files … downloadUrl"; agent runs `teams download --url <url> --out /tmp/x` → 200, file bytes correct | sandbox `ls -l`, `chmod 600` |
| L2 | `GET …/channels/teams/file?url=https://evil.example/x` | 400 "must be an https Microsoft/SharePoint file URL" | curl |
| L3 | `?url=http://…sharepoint.com/…` (http) | 400 | curl |
| L4 | Agent `teams send --file report.pdf --text "Here"` (< 4 MB) | Consent card "Kortix wants to send you report.pdf"; `teams_pending_uploads` row | DB |
| L5 | Accept | File appears in chat as a file-info card; row deleted | DB |
| L6 | Decline | Row deleted; nothing else posted | DB |
| L7 | Accept after 15 min | "That upload expired — ask me to send the file again." | Teams |
| L8 | File > 4 MB | 400 "exceeds the 4194304 byte upload limit" | CLI error |
| L9 | `POST …/file/upload` with `service_url=https://evil.example` | 400 "must be an https Microsoft Bot Framework endpoint"; no DB row | DB |
| L10 | Upload from a channel conversation (not personal) | Consent cards work only in personal scope in Teams — record the Bot Framework error and the CLI result | log |

### M. Connector (Graph reads from the sandbox)

| ID | Action | Expected |
|---|---|---|
| M1 | Connectors page after connect | `kortix_teams` listed with 9 read actions |
| M2 | Sandbox: `teams team --team <group id>` | Team JSON |
| M3 | `teams channels --team <id>`, `teams channel --team --channel`, `teams members --team`, `teams user --id <upn>` | 200 JSON each |
| M4 | `list_teams` via connector call | 200 (needs `Team.ReadBasic.All`) |
| M5 | `list_messages` / `get_message` / `list_replies` | 403 unless `ChannelMessage.Read.All` app-only is approved — record |
| M6 | Revoke a Graph permission in Entra; retry within 1 h | Still works (token cached ≤ 1 h) → then 403; document the cache |
| M7 | Rotate the client secret in Entra without updating Kortix | Outbound sends fail `Teams token request failed (401)`; after updating the env, restart the API (cache) |
| M8 | Disconnect → `teams team …` | Connector call fails "not connected" |

### N. Multi-project in one tenant

| ID | Action | Expected |
|---|---|---|
| N1 | Connect P1 and P2 to the same tenant | Both `chat_installs` rows; first message in a NEW conversation resolves to the first install row (order not guaranteed — record) |
| N2 | `/use P2` in conversation X; message | Session in P2; `chat_channel_bindings` row for X → P2 |
| N3 | Disconnect P2; message in X | Binding ignored (install gone) → falls back to P1 |
| N4 | Try `/use P3` (other account, same tenant not installed) | Not in list → projects card |

### O. Web UI ★

| ID | Action | Expected |
|---|---|---|
| O1 | Row states: not connected + creds → "Add to Teams"; connected → team name/tenant, "Open in Teams" only when `orgInstalled`, Disconnect with confirm | DOM |
| O2 | Viewer (no write) | Row visible, no action buttons |
| O3 | Panel: Connect disabled until tenant id; in BYO mode also app id + secret | DOM |
| O4 | Panel error banner on 400 from connect | Shows server message |
| O5 | `?teams=connected|review|failed|publishing|declined|disabled|unconfigured` landing on the Channels page | Each renders its toast once, and the `teams` param is removed from the URL (a reload shows no second toast) |
| O5b | Row with `publishState:"publishing"` | Badge with spinner; `GET …/installation` is re-requested every 3 s until the state settles, then polling stops (network tab) |
| O6 | `/teams/login/<token>` unauthenticated | Login → returns to the same page → bind runs once |
| O7 | Both themes, 720×480 window, Electron shell | No clipping in the row/panel (desktop-parity gate) |

### P. Security

| ID | Action | Expected |
|---|---|---|
| P1 | Managed token used against BYO endpoint (audience mismatch) | 401 |
| P2 | Activity with `serviceUrl=https://evil.example` but valid JWT for another serviceUrl | 401 (claim mismatch); if it ever reached send, `[teams-api] blocked outbound connector call to untrusted serviceUrl` |
| P3 | Bind token signed with a different secret | 410 |
| P4 | OAuth callback state signed with a different key | `teams_error=expired` |
| P5 | Anonymous `POST /v1/projects/P1/turn-stream {kind:"answer"}` | 401; a member without connector-write → 403 |

### Q. Dev deployment check ★

1. `curl -s https://dev-api.kortix.com/v1/health` → note the SHA.
2. Azure portal: bot `62b4470a-…` messaging endpoint = `https://dev-api.kortix.com/v1/webhooks/teams/messages`; Teams channel healthy; redirect URI `https://dev-api.kortix.com/v1/webhooks/teams/oauth/callback` registered; secret not expired.
3. Run B1, H1–H5, F1–F2, K1–K2, L1, L4–L5 against `https://dev.kortix.com`.
4. CloudWatch: filter `[teams-webhook]`, `[teams-oauth]`, `[teams-api]` for warnings during the run.

---

## 3b. Verified live on dev (2026-09-17/18)

- One-click install end to end: consent → `?teams=publishing` → row polls → `publishState:"published"`, catalog id `58f4d2ec…` (PR #7341).
- Welcome card, `/help`, `/login` + bind, `/whoami`, first task → live card → "Task complete" with session link; follow-up in the same personal chat joins the same session.
- Channel: `@Kortix Dev /help` → help card; `@Kortix Dev summarize …` → new session, answer in thread. An un-mentioned "hmm" got nothing (pre-RSC) — expected.
- Web: Teams badge/facet/card, `?teams=` toast, stripped titles (PRs #7385, #7388).

## 4. Known gaps found while reading the code (fix or accept before sign-off)

1. `TEAMS_CHANNEL_ENABLED` in `apps/api/.env.dev` is unread since #5908.
2. `kortix-teams` SKILL.md says "Disconnect is not in the CLI for Teams"; the CLI does implement `disconnect --platform teams`.
3. No public docs page: `apps/web/content/docs/connect/` has `slack.mdx` but no `teams.mdx`.
4. `apps/api/src/channels/teams-app-manifest.json` is a stale hand file (id `3f3c0cf4…`, `validDomains: kortix-teams.ngrok.app`); the API generates the real manifest.
5. `listTenantProjects` selects every row of `projects` (no `WHERE`) and filters in memory.
6. `/anything-not-a-command` starts a session instead of answering "unknown command" (personal chat / mentioned only).
7. `POST /identity/bind` returns `hasAccess` from account membership only, not project write, so the page can say "linked" to a user who will still get the Request-access card.
8. `MICROSOFT_APP_TENANT` on dev is pinned to one tenant; if the dev app registration is single-tenant, no external customer tenant can use the dev bot.
9. `ChannelMessage.Read.All` app-only needs Microsoft protected-API approval; three connector actions will 403 until then.


## 5. Slack → Teams parity gaps (2026-09-18)

**Update (later same day):** the batch below was worked through in priority
order. Now CLOSED: the sandbox connector slug (E2), pasted-image attachments,
follow-up outcomes + dead-session revive (C9, C10), the Teams bindings table
(F1), join policies (A1), channel/group file delivery (D1), step source
citations (C2), `teams send --card-file` (C3), the project picker (B1), and the
docs + skill (F4, F5). Still open or platform-limited: identity/access DMs
(A2/A3 — Teams has no ephemeral; the prompt replaces the live card instead),
native streaming (C1), proactive send to arbitrary channels (E1),
`slack edit/delete` twins (C4), App Home / `sessions` / `rebind`/`unbind`
(B2–B4), and the platform limits (reactions, ephemeral, search).


Everything Slack does that Teams does not, from `apps/api/src/channels/slack/*` (8.9k lines) vs `teams/*` (3.9k), the sandbox CLIs, the connector catalogs, the web, the CLI, tests and docs. **P1** = a user hits it in normal use; **P2** = noticeable; **P3** = nice-to-have; **PL** = Microsoft platform limit, not fixable 1:1.

### Access, identity, and who may talk to a session

| # | Slack | Teams today | Pri |
|---|---|---|---|
| A1 | **Conversation policies** per channel: `project_open` / `owner_only` / `owner_approval` (`slack/participants.ts`, `chat_channel_bindings.conversationPolicy`, `chat_thread_participants`). A second person replying in a thread is admitted, refused ("owner-only"), or held while the owner gets an ephemeral **Approve / Deny** card; requester gets an ephemeral "waiting" note. `/kortix policy` sets it. | None. Any linked member with `project.write` continues anyone's session; the policy column exists on Teams bindings but nothing reads it. | P1 |
| A2 | Identity prompt is posted **both** in-thread (ephemeral) and as a **DM** (`postIdentityPrompt`). | Card replaces the live card in the conversation only. No DM. | P2 |
| A3 | **Access request → admins are DM'd in Slack** with a "Review in Kortix" button (`notifyAdminsOfAccessRequest`, `slack_open_access_review`). | Managers get the Kortix in-app/email notification only; nothing in Teams. | P2 |
| A4 | Requester sees "already pending" when re-requesting. | Same (`pending` outcome) ✓ | – |
| A5 | `link-bot` command for BYO installs whose bot user id is unknown. | N/A (Teams knows the bot id from the manifest). | – |

### Multiple projects / workspaces

| # | Slack | Teams today | Pri |
|---|---|---|---|
| B1 | A workspace connected to **several projects** and a channel bound to none → a **project picker** is posted (`maybePostPicker`, `pendingPickers`, 10-min TTL). | `resolveConversationProject` silently takes the first `chat_installs` row. `/projects` and `/use` exist, but nothing tells the user a choice was made for them. | P1 |
| B2 | `/kortix rebind` / `/kortix unbind` a channel. | `/use` rebinds; no unbind. | P3 |
| B3 | `/kortix sessions` lists recent sessions for the channel; `session_open` button. | None. | P3 |
| B4 | **App Home** tab (`home.ts`, `app_home_opened`) listing connected projects. | None. Teams equivalent would be a personal tab or the `/status` card. | P3 |

### Delivery inside a turn

| # | Slack | Teams today | Pri |
|---|---|---|---|
| C1 | Native **streaming** answer (`chat.startStream` / `appendStream` / `stopStream`): the reply text grows token by token. | Card updated per `teams step`; the answer lands whole at `teams send`. Teams has a bot streaming API (`channelData.streamType`, 2024) that could be used. | P2 |
| C2 | Steps carry **`--source URL\|TITLE` citations** rendered as a footer. | `relayTurnStep` stores `sources` but `cards.ts stepElements` never renders them. | P2 |
| C3 | `slack send --blocks-file` for Block Kit answers (cards, carousels). | `teams send --card-file` for a raw Adaptive Card exists in the skill text but `teams.ts` has no `--card-file` handling (only text and `--file`). | P2 |
| C4 | `slack edit` / `slack delete` a posted message. | No `edit`/`delete` in the CLI; `updateActivity` exists in `teams-api.ts`, `deleteActivity` does not. | P3 |
| C5 | `slack react --emoji` (👀 on receipt, ✅ on done). | Bots cannot add reactions in Teams. | PL |
| C6 | `slack typing`. | `sendTyping` exists server-side; no CLI command (and the auto-indicator was removed on purpose). | P3 |
| C7 | Ephemeral (only-you-can-see) messages. | Not available to bots in Teams. | PL |
| C8 | Rich **start-error classification** (`slack/errors.ts`, 352 lines: balance parsing, abort patterns, provider errors, "revived thread" note). | `startErrorMessage` covers 402/429/404/other; turn errors reuse `classifyTurnError` ✓; no balance/provider detail in the copy. | P3 |
| C9 | A thread whose session was **deleted** is **revived**: stale `chat_threads` row dropped, new session created with a NOTE that history is gone. | `continueSession` on a deleted session returns `unreachable`; nothing is posted and the row stays. | P1 |
| C10 | Follow-up delivery failure → error rendered in the live message. | `deliverTeamsFollowUpToSession` result is ignored; a failed continue leaves "Working on it…" until the 30-min GC. | P1 |
| C11 | Keep-alive rules documented (5-min idle timeout). | 15-min `STREAM_TTL` + 30-min GC ✓ | – |

### Files and content

| # | Slack | Teams today | Pri |
|---|---|---|---|
| D1 | Outbound file to any channel/thread (`slack send --file --channel`). | Consent-card upload works **in personal chats only** (Teams limitation for `file.consent`). In channels/group chats the bot must upload to the team's SharePoint via Graph (`/drives`) or send an inline image. Not implemented. | P1 |
| D2 | Inbound files: `file_share` subtype, `file-info`, `download` through the proxy. | Inbound attachments listed in the prompt + `teams download` ✓; `--file-info` n/a. | – |
| D3 | `history` / `thread` reads via bot token. | `list_messages` / `get_message` / `list_replies` need the protected `ChannelMessage.Read.All` app permission → 403 until Microsoft approves; with RSC `ChannelMessage.Read.Group` consented, Graph allows them for that team. | P2 |
| D4 | `search` messages. | No Graph equivalent for app-only. | PL |

### Connector catalog and the sandbox CLI

| # | Slack | Teams today | Pri |
|---|---|---|---|
| E1 | 14 actions incl. **writes** (`send_message`, `update_message`, `delete_message`, `add_reaction`, `join_channel`). The agent can post to any channel proactively. | 9 **read** actions only. No proactive send (Bot Framework `createConversation` / proactive messaging not implemented). | P2 |
| E2 | Sandbox CLI resolves the connector as `kortix_slack` with a `slack` fallback. | Sandbox CLI calls `teams.<action>`; the materialized slug is `kortix_teams` and the router has no alias → **every `teams team/channels/members/user` call from a sandbox most likely 404s.** Verify live, then fix the slug. | P1 |
| E3 | `me` (`auth_test`), `channel-info`, `join`, `users`, `manifest`. | none / `channel` / – / `members` / – | P3 |
| E4 | Group chats: un-mentioned messages need RSC `ChatMessage.Read.Chat`. | Only `ChannelMessage.Read.Group` requested → group-chat threads still need a mention. | P2 |
| E5 | Inbound `message_changed` / `message_deleted` ignored on purpose. | `messageUpdate` / `messageDelete` / `messageReaction` activities arrive with RSC and are ignored ✓ (could drive "edit = resend"). | – |

### Web, CLI, tests, docs

| # | Slack | Teams today | Pri |
|---|---|---|---|
| F1 | **Bindings table** (agent / model / join policy per channel) on the Channels page, and `channel-bindings.ts` fills channel names for Slack. | Table renders only under the Slack install; Teams bindings are invisible in the UI and would show raw conversation ids (`…@thread.tacv2;messageid=…`). `kortix channels bindings/bind` works for both. | P1 |
| F2 | Three-step **BYO wizard** (`slack-byo-wizard.tsx`), connect hero card with preview. | Manual/BYO panel is a form; no wizard, no preview. | P3 |
| F3 | 28 REST flows (`CHN-1…28`) incl. dispatch, OAuth, interactivity, commands, thread bind, file download boundary. | 4 flows (`CHN-T1…T4`). Missing: OAuth callback statuses, interactivity invoke auth, identity bind, file proxy boundary, BYO endpoint, dispatch. | P2 |
| F4 | `docs/connect/slack.mdx`. | No `teams.mdx`. | P2 |
| F5 | `kortix-slack` skill: keep-alive rules, Block Kit cheat-sheet, carousel, question tool section, file section. | `kortix-teams` skill lacks the Adaptive Card cheat-sheet, the RSC/mention rules, the personal-chat-only file caveat, and still says disconnect is not in the CLI. | P2 |

### Already at parity (for the record)

Welcome card on install; `/login` + pending-message resume; `/whoami`, `/logout`; `/status`, `/models`, `/model`, `/agents`, `/agent`, `/projects`, `/use`; per-conversation agent+model selection; question tool (`relayTurnQuestion` → platform); Review Center approve/changes/deny cards; live step card; 5-min event dedup; identity/membership/`project.write` gate; OAuth-style one-click install; BYO bot; inbound attachments + download proxy; session badge/facet + incoming/outgoing cards in the web.

## 6. Pasted images: the model, not the channel (2026-09-21)

The Teams download path was never broken. Evidence from the live dev session
`196a99f5-8d4d-4d48-988e-cec7152e0d10`, read back from OpenCode through the
sandbox proxy:

| Step the agent ran | Result |
|---|---|
| `teams download --url https://smba.trafficmanager.net/emea/…/views/original --out /workspace/ivan-image.png` | `{"ok":true,"size":28740}` |
| `file /workspace/ivan-image.png` | `PNG image data, 844 x 281, 8-bit/color RGBA` |
| `read /workspace/ivan-image.png` | `Image read successfully` |
| then | `which identify` → no ImageMagick; `which tesseract`; `REPLICATE_API_TOKEN set: yes` |
| finally | assistant message with **zero parts** — the turn ended with no `teams send` |

The session ran on `kortix/deepseek-v4-flash`. Its served catalog entry (read
from the sandbox at `/v1/p/<ext>/4096/config/providers`) says
`capabilities.attachment: false` and `capabilities.input.image: false`, so
OpenCode never sends the image upstream. The agent held a valid PNG that the
model could not look at, went hunting for OCR tooling, and gave up.

`LLM_GATEWAY_VISION_MODEL` (`gpt-5.6-luna`, `input.image: true`) already
encodes the intended answer, but the gateway rule in
`llm-gateway/routing/resolve-route.ts` only fires when an image part reaches
the gateway — and OpenCode strips it before that, precisely because the model
declares it cannot take one.

**Fix:** the channel picks the model, because the channel is what knows the
inbound message has an image. `channels/vision-model.ts` resolves the target;
Teams and Slack both use it. A follow-up gets a per-prompt
`overrides.model` (the session's pin is untouched); a conversation that opens
with an image is created on the vision model. Off-gateway deployments are a
no-op.

**The configured target is not always servable.** Probed live on dev with a
real prompt override:

| model | result |
|---|---|
| `gpt-5.6-luna` (the `LLM_GATEWAY_VISION_MODEL` default) | `APIError`: *requires Kortix's managed provider, which is disabled on this deployment* |
| `glm-5.3-flash` | answered `probe ok` |

So the selector walks candidates — configured target, platform default, then
the catalog's vision-capable models cheapest-first — and takes the first that
passes `isModelServableForAccount`. Pinning a prompt to an unservable model
turns a degraded answer into a failed turn, which is worse than not routing at
all; when no candidate qualifies the turn runs unchanged and logs why.

Also fixed here: Teams sends inline images as the wildcard type `image/*`, so
the prompt used to name the file `image.*`.

### How to check it live

1. Paste a screenshot into the personal chat with the bot and ask about it.
2. `select metadata->>'opencode_model' from kortix.project_sessions where session_id = '<id>';`
   — an image-opened conversation reads `kortix/gpt-5.6-luna`.
3. For a follow-up in an existing conversation the pin does NOT change; look
   for `[teams-webhook] routing an image-bearing turn to the vision model` and
   for the answer itself describing the image.

### A retired model pin kills a conversation just as quietly

Probed on dev 2026-09-21 with `PUT /v1/projects/:pid/sessions/:sid/model`,
which runs the same `isModelServableForAccount` check a session create does:

| model | result |
|---|---|
| `deepseek-v4-flash` — what the Teams session had been pinned to since 2026-09-18 | `400 INVALID_SESSION_MODEL`, *not available for this account* |
| `deepseek-v4.1-flash` — the current platform default, vision-capable | `200 applied_live` |
| `glm-5.3-flash` — cheapest vision-capable | `200 applied_live` |
| `deepseek-v4-pro-0813` — servable, `attachment: false` | `200 applied_live` |
| `gpt-5.6-luna` | `400 INVALID_SESSION_MODEL` |

Nothing re-validates a session's pin after creation, so a model retired from
the catalog leaves the conversation answering nothing, forever, with no
message to the user. `channelTurnModel` now replaces an unservable pin as well
as a vision-incapable one. The cheap signal is absence from
`gatewayModelCatalog`; the decision is always confirmed with
`isModelServableForAccount` before anything is replaced.

`deepseek-v4-pro-0813` is the fixture for testing the vision path by hand: it
serves, and it cannot read images.

### Round two: `attachment` is not the vision flag

The first fix routed the image turn away from `deepseek-v4-flash` correctly —
and landed on `glm-5.3-flash`, which also cannot see images. The agent replied
*"the model I'm running on right now can't process images"*.

Read from the sandbox at `/v1/p/<ext>/4096/config/providers`:

| model | `attachment` | `input.image` | servable on dev |
|---|---|---|---|
| `glm-5.3-flash` | true | **false** | yes |
| `deepseek-v4-flash` | false | false | **no** (retired) |
| `gpt-5.6-luna` | true | true | **no** (managed provider off) |
| `codex/gpt-6-astra`, `codex/gpt-5.6-sol`, `codex/gpt-5.6-terra`, `codex/gpt-5.6-luna`, `codex/gpt-5.5` | true | true | yes |

`glm-5.3-flash` is `vision: true` by hand in `packages/llm-catalog` while its
`pricingRef` record on models.dev carries text-only modalities. OpenCode
honours the modalities, so `attachment` is the wrong predicate. The selector
now uses `modalities.input` containing `image`, and falls back to `attachment`
only when a model publishes no modalities at all.

Two more things this round:

- Candidates now come from `servableProjectCatalog` — the same list the
  sandbox registers and the picker shows — instead of the whole org catalog,
  so the probe loop cannot exhaust itself on BYOK models this project cannot
  run.
- `promptModelOverride` must NOT split the model id on its slash. Every served
  model is registered under the one synthetic `kortix` OpenCode provider, so
  `codex/gpt-6-astra` is a model on `kortix`, not a model on a provider
  `codex`. Splitting it addressed a provider the runtime does not have and the
  override was dropped silently.

**On dev, the image-capable models are the five `codex/*` ones.**
