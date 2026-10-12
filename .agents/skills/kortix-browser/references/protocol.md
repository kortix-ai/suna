# Kortix Browser protocol

The contract between the four parts of Kortix Browser. Every part implements
exactly this. Change this file in the same commit as any wire change.

| Part | Path | Talks to |
|---|---|---|
| Extension (MV3) | `apps/browser-extension` | API control socket, API REST, sandbox bridge |
| API | `apps/api/src/browser/` | Extension control socket, sandbox (kortixd) |
| kortixd | `apps/kortix-sandbox-agent-server/src/routes/kortix/browser*` | API, extension bridge, CDP clients |
| CLI | `apps/cli/src/commands/browser.ts` | kortixd on `127.0.0.1:8000`, API |

## 1. Identity and auth

- **Extension ID:** `gefbbnjgoiljpbnalgafbhbfdhikgjek`. It is fixed by the
  `key` field in `manifest.json`. The private key is `BROWSER_EXTENSION_KEY_PEM_B64`
  (dotenvx, `apps/api/.env`). Include it as `key.pem` in the first Chrome Web
  Store upload to keep the ID.
- **Extension credential:** OAuth 2.1 with PKCE (S256) against the API's existing
  authorization server. The extension registers itself with
  `POST /v1/oauth/register` (`client_name: "Kortix for Chrome"`,
  `redirect_uris: ["chrome-extension://gefbbnjgoiljpbnalgafbhbfdhikgjek/welcome.html"]`,
  `token_endpoint_auth_method: "none"`). Sign-in runs in a normal tab: the
  welcome page's tab goes to `/v1/oauth/authorize` (`scope=kortix`), and Kortix
  sends it back to `welcome.html` (web-accessible), which finishes the code
  exchange. The API shows a client whose only redirect is that URI as the
  verified Kortix extension. Tokens: `kortix_oat_` (1 h) and a rotating
  `kortix_ort_` (30 days). The extension refreshes 5 min before expiry.
  Endpoints come from `GET <api>/.well-known/oauth-authorization-server`.
  Before sign-in, `GET /v1/browsers` without a token answers `401` on a server
  with Kortix Browser and `404` on one without it.
- **Sandbox credential:** the session-scoped `KORTIX_TOKEN` (`kortix_pat_`). The
  API resolves it to `{userId, sessionId, projectId}`. The browser owner must be
  that `userId`.
- **API URL:** the extension stores one API origin, for example
  `https://api.kortix.com`. Every path below is relative to it.

## 2. Data model (`kortix` schema)

```
browser_connections
  browser_id uuid pk, user_id uuid not null, account_id uuid not null,
  name varchar(255) not null, brand text not null, os text not null,
  profile_label text, extension_version text,
  access_mode text not null default 'always'   -- always | ask | off
  tab_scope   text not null default 'own'      -- own | all
  relay_owner_id text, last_seen_at timestamptz, revoked_at timestamptz,
  created_at, updated_at
browser_grants
  grant_id uuid pk, browser_id fk, project_id text not null, session_id text,
  decision text not null                        -- allow | deny
  created_at
browser_attachments
  attachment_id uuid pk, browser_id fk, user_id uuid, project_id text,
  session_id text not null, status text not null,
  -- pending | granted | connected | denied | ended | failed
  end_reason text, created_at, updated_at
```

**Online** means `revoked_at is null` and `last_seen_at > now() - 75 s`.

## 3. Control socket (extension ↔ API)

`wss://<api>/v1/browser/ws`. Text frames, JSON. No `Origin` restriction: the
token is the gate. The first frame must arrive within 10 s.

| Direction | Frame |
|---|---|
| ext → api | `{"type":"auth","token":"kortix_oat_…","browserId":"<uuid or null>","info":{"brand":"Chrome","os":"macOS","profileLabel":"Work","extensionVersion":"1.0.0"}}` |
| api → ext | `{"type":"auth_ok","browser":Browser,"webUrl":"https://kortix.com"}`. If `browserId` is null, unknown, revoked or owned by another user, the API creates a new row. The extension stores the returned `browser.id`. |
| api → ext | close `4001` (bad token) · `4003` (browser disconnected from Kortix) |
| ext → api | `{"type":"ping"}` every 20 s. The API answers `{"type":"pong"}` and sets `last_seen_at`. |
| api → ext | `{"type":"attach","attachmentId","sessionId","sessionTitle","projectId","projectName","bridgePath","ticket","consent":true|false}` |
| ext → api | `{"type":"consent","attachmentId","decision":"session"|"project"|"deny"}` |
| ext → api | `{"type":"attached","attachmentId"}` after the bridge socket opens |
| ext → api | `{"type":"detached","attachmentId","reason":"stopped"|"closed"|"canceled_by_user"|"error"}` |
| api → ext | `{"type":"detach","attachmentId"}` (session released the browser) |
| api → ext | `{"type":"browser","browser":Browser}` after a REST change (rename, mode, scope) |

`Browser` = `{"id","name","brand","os","profileLabel","extensionVersion","accessMode","tabScope","online","lastSeenAt","createdAt","activeSessions":[{"sessionId","projectId","title"}]}`.

**Cross-replica delivery.** Each API replica keeps a replica-local
`Map<browserId, ServerWebSocket>`. To send to a browser, a replica delivers
locally if it holds the socket. Otherwise it runs
`select pg_notify('kortix_browser_cmd', $1)` with `{"browserId","frame"}`
(always under 8 KB). Every replica listens and delivers if it holds the socket.

## 4. REST

User routes accept a Supabase JWT, `kortix_pat_` or `kortix_oat_`. They return
only the caller's own browsers.

| Route | Result |
|---|---|
| `GET /v1/browsers` | `200 Browser[]`, newest `last_seen_at` first |
| `PATCH /v1/browsers/:id` | body `{name?, accessMode?, tabScope?}` → `200 Browser`. Pushes `{"type":"browser"}` to the extension. |
| `DELETE /v1/browsers/:id` | `204`. Sets `revoked_at`, sends close `4003`, ends active attachments. |

Sandbox routes accept only a session-scoped sandbox credential.

| Route | Result |
|---|---|
| `POST /v1/browser/attach` | body `{"browser":"<name or id, optional>","ticket":"<base64url>","ask":false}` → see below |
| `POST /v1/browser/release` | body `{"attachmentId"}` → `204`. Sends `detach`, sets status `ended`. |

`POST /v1/browser/attach`:
1. Pick the browser. With `browser` set, match `id` or case-insensitive `name`
   among the owner's non-revoked browsers. Without it, take the owner's online
   browser with the newest `last_seen_at`.
2. Decide consent. `access_mode = off` → `403 browser_access_off`. A `deny` grant
   for this session → `403 browser_denied`. `always` with `ask=false` → granted. A
   project or session `allow` grant → granted. Otherwise → consent needed.
3. Insert an attachment (`pending`, or `granted`). Send `attach` with
   `consent`. `bridgePath` =
   `/v1/p/<session_sandboxes.external_id>/8000/kortix/browser/bridge?ticket=<ticket>`.
4. Wait up to 120 s, polling the attachment row every 300 ms. `granted` or
   `connected` → `200`. `denied` → `403 browser_denied`. Timeout →
   `408 browser_consent_timeout`, and the status becomes `failed`.

`200` body: `{"attachmentId","browser":Browser}`.

Error body, every route: `{"error":"<sentence a person can act on>","code":"<code>","connectUrl":"<FRONTEND_URL>/settings/browsers"}`.

| Code | HTTP | When |
|---|---|---|
| `browser_not_connected` | 404 | The owner has no non-revoked browser |
| `browser_not_found` | 404 | `browser` matches none |
| `browser_offline` | 409 | The chosen browser is not online |
| `browser_access_off` | 403 | Access mode is Off |
| `browser_denied` | 403 | Denied in Chrome, or the user pressed Stop for this session |
| `browser_consent_timeout` | 408 | Nobody answered in 120 s |

Consent decisions: `session` → `allow` grant with `session_id`. `project` →
`allow` grant without `session_id`. `deny` → `deny` grant with `session_id`.
Stop in Chrome → `detached` with `stopped` → the API writes a `deny` grant for
that session. The agent then needs `ask=true` (a fresh prompt in Chrome) to use
the browser again.

## 5. Bridge (extension ↔ kortixd)

The extension opens `wss://<api><bridgePath>&token=<kortix_oat_>`. The API
preview proxy authenticates the token, checks access to the sandbox, and
forwards to kortixd port 8000 with a signed `X-Kortix-User-Context`. kortixd
accepts the upgrade only with a valid user context and the current `ticket`.
One bridge per sandbox. A new valid dial replaces the old one.

Frames are JSON text. `c` is a kortixd-assigned CDP client id (string).

| Direction | Frame | Meaning |
|---|---|---|
| ext → kd | `{"hello":{"browser":Browser,"tabScope":"own"|"all"}}` | First frame |
| kd → ext | `{"c":"1","open":true}` | A CDP client connected to `127.0.0.1:9333` |
| kd → ext | `{"c":"1","m":{…CDP command…}}` | A CDP command from that client |
| ext → kd | `{"c":"1","m":{…CDP response or event…}}` | A reply or event for that client |
| kd ↔ ext | `{"c":"1","close":true}` | The client closed, or the extension drops it |
| kd ↔ ext | `{"ping":1}` / `{"pong":1}` | Every 20 s, both directions |

## 6. CDP endpoint (kortixd, inside the sandbox)

`127.0.0.1:9333`, loopback only, alive while a bridge is attached.

- `GET /json/version` → `{"Browser":"Kortix/<brand>","Protocol-Version":"1.3","User-Agent":"…","webSocketDebuggerUrl":"ws://127.0.0.1:9333/devtools/browser/kortix"}`
- `GET /json`, `/json/list` → `[]`
- WS on any `/devtools/*` path → one CDP client. With no bridge attached, the
  socket closes at once: `1011 No browser attached. Run: kortix browser use`.

## 7. CDP shim (extension)

The extension is the browser-level CDP endpoint for each client. Browser-level
methods (no `sessionId`):

| Method | Behavior |
|---|---|
| `Browser.getVersion` | `{protocolVersion:"1.3", product:"Chrome/<ver>", revision:"", userAgent, jsVersion:""}` |
| `Browser.getWindowForTarget` | `{windowId, bounds}` from `chrome.windows.get` |
| `Browser.setContentsSize`, `Browser.setDownloadBehavior`, `Browser.close` | `{}`, no effect. The user's browser is never resized or closed. |
| `Target.setDiscoverTargets` | `{}`. While `discover` is true, emit `Target.targetCreated` for every in-scope tab now and later, `targetInfoChanged` on URL or title change, and `targetDestroyed` on close. |
| `Target.getTargets` | `{targetInfos}` for in-scope tabs. With none, first create one `about:blank` tab in scope. |
| `Target.createTarget` | `chrome.tabs.create({url, active:false})` in the session window, add it to the session group, return `{targetId}` |
| `Target.attachToTarget` | `chrome.debugger.attach({tabId},"1.3")` once per tab, mint `sessionId`, emit `Target.attachedToTarget`, return `{sessionId}` |
| `Target.detachFromTarget` | Drop that session. Detach the debugger when no client uses the tab. |
| `Target.closeTarget` | `chrome.tabs.remove`, return `{success:true}` |
| `Target.activateTarget` | `chrome.tabs.update(tabId,{active:true})` |
| `Target.getTargetInfo` | The tab's info, or the browser target without `targetId` |
| other | error `-32601 "<method> is not available in Kortix Browser"` |

Commands with a `sessionId` go to `chrome.debugger.sendCommand({tabId[, sessionId: child]}, method, params)`.
Events from `chrome.debugger.onEvent` go to every client session on that tab.
Child sessions (`source.sessionId`) keep their own id. `targetId` is the real
CDP id from `chrome.debugger.getTargets()`.

**Scope.** `own`: tabs in the session's tab group (created by it, or shared into
it, or opened from it). `all`: every `http`, `https`, `file` and `about:blank`
tab. `chrome://`, the Web Store and extension pages are never in scope.

**Visible state.** Each attachment has one tab group `Kortix · <sessionTitle>`
(color `blue`). The overlay (glow, agent cursor at each
`Input.dispatchMouseEvent` point, control bar with Take over and Stop) shows on
every tab of the group. Before `Page.captureScreenshot` the shim activates the
tab in its own window. Take over pauses: `Input.*` returns `-32000 "The user took
over this tab. Wait for them, then retry."` until Resume. Stop and the Chrome
infobar's Cancel detach the debugger from the group, close the bridge, and send
`detached`.

## 8. kortixd local routes (for the CLI)

Bearer `KORTIX_TOKEN` (`authorizeControl`).

| Route | Result |
|---|---|
| `POST /kortix/browser/attach` body `{"browser"?,"ask"?}` | Generates a ticket and calls `POST /v1/browser/attach`. On `200`, waits up to 30 s for the bridge, then `200 {"attachmentId","browser":Browser,"cdpPort":9333}`. Errors pass through with the API body and status. A dial timeout → `502 browser_dial_failed`. |
| `POST /kortix/browser/release` | Calls the API release, closes the bridge → `204` |
| `GET /kortix/browser/status` | `{"attached":bool,"browser":Browser|null,"clients":n,"cdpPort":9333}` |

## 9. CLI

`kortix browser ls|use|status|release`, `--json` on each.

```
$ kortix browser use
✓ Using Chrome · Work (macOS)
  Drive it: agent-browser --cdp 9333 open https://example.com
$ kortix browser use
✗ No browser is connected to Kortix.
  Ask the user to connect one: https://kortix.com/settings/browsers
```

## 10. Web → extension (`externally_connectable`)

Allowed origins: `https://kortix.com`, `https://www.kortix.com`,
`https://dev.kortix.com`, `https://staging.kortix.com`, `http://localhost`.

| Message | Reply |
|---|---|
| `{"type":"kortix.ping"}` | `{"ok":true,"version","connected":bool,"apiUrl","browserId"}` |
| `{"type":"kortix.connect","apiUrl"}` | Starts sign-in. `{"ok":true,"browserId"}` or `{"ok":false,"error"}` |

The extension derives the API URL from `sender.origin` for the Kortix hosts:
`kortix.com` and `www` → `https://api.kortix.com`, `dev` →
`https://dev-api.kortix.com`, `staging` → `https://staging-api.kortix.com`.
It accepts the message's `apiUrl` only from `http://localhost`, and only when
that `apiUrl` is itself `http://localhost:*`.
