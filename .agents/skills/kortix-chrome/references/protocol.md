# Kortix in Chrome protocol

The contract between the four parts of Kortix in Chrome. Every part implements
exactly this. Change this file in the same commit as any wire change.

| Part | Path | Talks to |
|---|---|---|
| Extension (MV3) | `apps/chrome-extension` | API control socket, API REST, sandbox bridge |
| API | `apps/api/src/chrome/` | Extension control socket, sandbox (kortixd) |
| kortixd | `apps/kortix-sandbox-agent-server/src/routes/kortix/chrome*` | API, extension bridge, CDP clients |
| CLI | `apps/cli/src/commands/chrome.ts` | kortixd on `127.0.0.1:8000`, API |

## 1. Identity and auth

- **Extension ID:** `gefbbnjgoiljpbnalgafbhbfdhikgjek`. It is fixed by the
  `key` field in `manifest.json`. The private key is `BROWSER_EXTENSION_KEY_PEM_B64`
  (dotenvx, `apps/api/.env`). Include it as `key.pem` in the first Chrome Web
  Store upload to keep the ID.
- **Extension credential:** OAuth 2.1 with PKCE (S256) against the API's existing
  authorization server. The extension registers itself with
  `POST /v1/oauth/register` (`client_name: "Kortix in Chrome"`,
  `redirect_uris: ["chrome-extension://gefbbnjgoiljpbnalgafbhbfdhikgjek/welcome.html"]`,
  `token_endpoint_auth_method: "none"`). Sign-in runs in a normal tab: the
  welcome page's tab goes to `/v1/oauth/authorize` (`scope=kortix`), and Kortix
  sends it back to `welcome.html` (web-accessible), which finishes the code
  exchange. The API shows a client whose only redirect is that URI as the
  verified Kortix extension. Tokens: `kortix_oat_` (1 h) and a rotating
  `kortix_ort_` (30 days). The extension refreshes 5 min before expiry.
  Endpoints come from `GET <api>/.well-known/oauth-authorization-server`.
  Before sign-in, `GET /v1/chrome/connections` without a token answers `401` on a server
  with Kortix in Chrome and `404` on one without it.
- **Sandbox credential:** the session-scoped `KORTIX_TOKEN` (`kortix_pat_`). The
  API resolves it to `{userId, sessionId, projectId}`. The browser owner must be
  that `userId`.
- **API URL:** the extension stores one API origin, for example
  `https://api.kortix.com`. Every path below is relative to it.

## 2. Data model (`kortix` schema)

```
chrome_connections
  chrome_id uuid pk, user_id uuid not null, account_id uuid not null,
  name varchar(255) not null, brand text not null, os text not null,
  profile_label text, extension_version text,
  access_mode text not null default 'always'   -- always | ask | off
  tab_scope   text not null default 'all'      -- all | own
  relay_owner_id text, last_seen_at timestamptz, revoked_at timestamptz,
  created_at, updated_at
chrome_grants
  grant_id uuid pk, chrome_id fk, project_id text not null, session_id text,
  decision text not null                        -- allow | deny
  created_at
chrome_attachments
  attachment_id uuid pk, chrome_id fk, user_id uuid, project_id text,
  session_id text not null, status text not null,
  -- pending | granted | connected | denied | ended | failed
  end_reason text, created_at, updated_at
```

**Online** means `revoked_at is null` and `last_seen_at > now() - 75 s`.

## 3. Control socket (extension ↔ API)

`wss://<api>/v1/chrome/ws`. Text frames, JSON. No `Origin` restriction: the
token is the gate. The first frame must arrive within 10 s.

| Direction | Frame |
|---|---|
| ext → api | `{"type":"auth","token":"kortix_oat_…","chromeId":"<uuid or null>","info":{"brand":"Chrome","os":"macOS","profileLabel":"Work","extensionVersion":"1.0.0"}}` |
| api → ext | `{"type":"auth_ok","chrome":ChromeConnection,"webUrl":"https://kortix.com"}`. If `chromeId` is null, unknown, revoked or owned by another user, the API creates a new row. The extension stores the returned `chrome.id`. |
| api → ext | close `4001` (bad token) · `4003` (browser disconnected from Kortix) |
| ext → api | `{"type":"ping"}` every 20 s. The API answers `{"type":"pong"}` and sets `last_seen_at`. |
| api → ext | `{"type":"attach","attachmentId","sessionId","sessionTitle","projectId","projectName","bridgePath","ticket","consent":true|false}` |
| ext → api | `{"type":"consent","attachmentId","decision":"session"|"project"|"deny"}` |
| ext → api | `{"type":"attached","attachmentId"}` after the bridge socket opens |
| ext → api | `{"type":"detached","attachmentId","reason":"stopped"|"closed"|"canceled_by_user"|"error"}` |
| api → ext | `{"type":"detach","attachmentId"}` (session released the browser) |
| api → ext | `{"type":"chrome","chrome":ChromeConnection}` after a REST change (rename, mode, scope) |

`ChromeConnection` = `{"id","name","brand","os","profileLabel","extensionVersion","accessMode","tabScope","online","lastSeenAt","createdAt","activeSessions":[{"sessionId","projectId","title"}]}`.

**Cross-replica delivery.** Each API replica keeps a replica-local
`Map<chromeId, ServerWebSocket>`. To send to a browser, a replica delivers
locally if it holds the socket. Otherwise it runs
`select pg_notify('kortix_chrome_cmd', $1)` with `{"chromeId","frame"}`
(always under 8 KB). Every replica listens and delivers if it holds the socket.

## 4. REST

User routes accept a Supabase JWT, `kortix_pat_` or `kortix_oat_`. They return
only the caller's own browsers.

| Route | Result |
|---|---|
| `GET /v1/chrome/connections` | `200 Browser[]`, newest `last_seen_at` first |
| `PATCH /v1/chrome/connections/:id` | body `{name?, accessMode?, tabScope?}` → `200 Browser`. Pushes `{"type":"chrome"}` to the extension. |
| `DELETE /v1/chrome/connections/:id` | `204`. Sets `revoked_at`, sends close `4003`, ends active attachments. |

| `POST /v1/chrome/panel-session` | Only a `kortix_oat_` token issued to the Kortix in Chrome client (else `403 chrome_panel_forbidden`). `200 {tokenHash}`: a one-time Supabase magiclink hash for the token's user. The side panel exchanges it for a web session. Never log it. |

### Side panel sign-in

The side panel iframes `${webUrl}/auth/panel?next=/panel`, the new chat (§11). Chrome hides `SameSite=Lax`
cookies from frames inside extension pages, so the web app keeps the panel session in a
partitioned cookie and gets it from the extension:

1. The page posts `{type:"kortix.panel.needSession"}` to its parent.
2. The panel accepts it only when `event.origin` is the web origin and `event.source` is its iframe.
3. The panel asks the worker (`panel-session` RPC), which calls `POST /v1/chrome/panel-session`.
4. The panel posts `{type:"kortix.panel.session", tokenHash}` to the iframe with the web origin as target.

At most 2 requests per frame navigation (one request, one retry).

Sandbox routes accept only a session-scoped sandbox credential.

| Route | Result |
|---|---|
| `POST /v1/chrome/attach` | body `{"chrome":"<name or id, optional>","ticket":"<base64url>","ask":false}` → see below |
| `POST /v1/chrome/release` | body `{"attachmentId"}` → `204`. Sends `detach`, sets status `ended`. |

`POST /v1/chrome/attach`:
1. Pick the browser. With `chrome` set, match `id` or case-insensitive `name`
   among the owner's non-revoked browsers. Without it, take the owner's online
   browser with the newest `last_seen_at`.
2. Decide consent. `access_mode = off` → `403 chrome_access_off`. A `deny` grant
   for this session → `403 chrome_denied`. `always` with `ask=false` → granted. A
   project or session `allow` grant → granted. Otherwise → consent needed.
3. Insert an attachment (`pending`, or `granted`). Send `attach` with
   `consent`. `bridgePath` =
   `/v1/p/<session_sandboxes.external_id>/8000/kortix/chrome/bridge?ticket=<ticket>`.
4. Wait up to 120 s, polling the attachment row every 300 ms. `granted` or
   `connected` → `200`. `denied` → `403 chrome_denied`. Timeout →
   `408 chrome_consent_timeout`, and the status becomes `failed`.

`200` body: `{"attachmentId","chrome":ChromeConnection}`.

Error body, every route: `{"error":"<sentence a person can act on>","code":"<code>","connectUrl":"<FRONTEND_URL>/settings/chrome"}`.

| Code | HTTP | When |
|---|---|---|
| `chrome_not_connected` | 404 | The owner has no non-revoked browser |
| `chrome_not_found` | 404 | `chrome` matches none |
| `chrome_offline` | 409 | The chosen browser is not online |
| `chrome_access_off` | 403 | Access mode is Off |
| `chrome_denied` | 403 | Denied in Chrome, or the user pressed Stop for this session |
| `chrome_consent_timeout` | 408 | Nobody answered in 120 s |

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
| ext → kd | `{"hello":{"chrome":ChromeConnection,"tabScope":"own"|"all"}}` | First frame |
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
  socket closes at once: `1011 No browser attached. Run: kortix chrome use`.

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
| other | error `-32601 "<method> is not available in Kortix in Chrome"` |

Commands with a `sessionId` go to `chrome.debugger.sendCommand({tabId[, sessionId: child]}, method, params)`.
Events from `chrome.debugger.onEvent` go to every client session on that tab.
Child sessions (`source.sessionId`) keep their own id. `targetId` is the real
CDP id from `chrome.debugger.getTargets()`.

**Scope.** `all` (default): every `http`, `https`, `file` and `about:blank` tab in
every window. `own`: the tabs the session opened, shared into it, or opened from
them. Either way the session's own tabs come first in `Target.getTargets` (one
is created if it has none), so a CDP client starts in a tab of its own and never
navigates a tab the user is reading. Tab groups are decoration: a browser
without `chrome.tabGroups` (Arc, Dia) works the same. `chrome://`, the Web Store and extension pages are never in scope.

**Visible state.** Each attachment has one tab group `Kortix · <sessionTitle>`
(color `blue`). The overlay (glow, agent cursor at each
`Input.dispatchMouseEvent` point, control bar with Take over and Stop) shows on
every tab of the group. Before `Page.captureScreenshot` the shim activates the
tab in its own window. Take over pauses: `Input.*` returns `-32000 "The user took
over this tab. Wait for them, then retry."` until Resume. Stop and the Chrome
infobar's Cancel detach the debugger from the group, close the bridge, and send
`detached`.

**Page dialogs.** If a command to a tab is still in flight 1 s after
`Page.javascriptDialogOpening`, the shim sends `Page.handleJavaScriptDialog`
`{accept:true}` (plus `promptText: defaultPrompt` for a prompt). A client that is
not stuck answers the dialog itself.

**Uploads.** kortixd rewrites a client's `DOM.setFileInputFiles` (sandbox paths)
into `Kortix.setFileInputFiles` `{nodeId|backendNodeId|objectId, files:[{name,
type, data(base64)}]}`, at most 10 MB in total; a missing file answers the client
with a CDP error at once. The shim resolves the node and sets a `DataTransfer` of
real `File`s on the input, then fires `input` and `change`.

## 8. kortixd local routes (for the CLI)

Bearer `KORTIX_TOKEN` (`authorizeControl`).

| Route | Result |
|---|---|
| `POST /kortix/chrome/attach` body `{"chrome"?,"ask"?}` | Generates a ticket and calls `POST /v1/chrome/attach`. On `200`, waits up to 30 s for the bridge, then `200 {"attachmentId","chrome":ChromeConnection,"cdpPort":9333}`. Errors pass through with the API body and status. A dial timeout → `502 chrome_dial_failed`. |
| `POST /kortix/chrome/release` | Calls the API release, closes the bridge → `204` |
| `GET /kortix/chrome/status` | `{"attached":bool,"chrome":ChromeConnection|null,"clients":n,"cdpPort":9333}` |

## 9. CLI

`kortix chrome ls|use|status|release`, `--json` on each.

```
$ kortix chrome use
✓ Using Chrome · Work (macOS)
  Drive it: agent-browser --cdp 9333 open https://example.com
$ kortix chrome use
✗ No browser is connected to Kortix.
  Ask the user to connect one: https://kortix.com/settings/chrome
```

## 10. Web → extension (`externally_connectable`)

Allowed origins: `https://kortix.com`, `https://www.kortix.com`,
`https://dev.kortix.com`, `https://staging.kortix.com`, `http://localhost`.

| Message | Reply |
|---|---|
| `{"type":"kortix.ping"}` | `{"ok":true,"version","connected":bool,"apiUrl","chromeId"}` |
| `{"type":"kortix.connect","apiUrl"}` | Starts sign-in. `{"ok":true,"chromeId"}` or `{"ok":false,"error"}` |

The extension derives the API URL from `sender.origin` for the Kortix hosts:
`kortix.com` and `www` → `https://api.kortix.com`, `dev` →
`https://dev-api.kortix.com`, `staging` → `https://staging-api.kortix.com`.
It accepts the message's `apiUrl` only from `http://localhost`, and only when
that `apiUrl` is itself `http://localhost:*`.

## 11. Side panel page channel (extension ↔ `/panel`)

The side panel opens `/panel`, a new chat, every time. The page and the side
panel talk through `postMessage`. Each side checks the other: the page accepts
only `event.origin` = `chrome-extension://<extension id>` from `window.parent`.
The panel accepts only the web origin from its own iframe
(`apps/chrome-extension/src/pages/panel-bridge.ts`,
`apps/web/src/features/chrome/panel/panel-channel.ts`).

Page → panel:

| Message | Effect |
|---|---|
| `{"type":"kortix.panel.hello"}` | The panel answers `kortix.panel.tab` and delivers a waiting right-click context. |
| `{"type":"kortix.panel.tabs","requestId"}` | `kortix.panel.tabs.result` with the tabs of the panel's window. |
| `{"type":"kortix.panel.read","requestId","tabIds":[…]}` | `kortix.panel.read.result`. 1 to 8 tabs. The panel runs a script in each tab and returns `body.innerText`, cut at 100,000 characters. |
| `{"type":"kortix.panel.act","tabId"}` | Act: the next session the panel opens within 5 minutes gets this tab. |
| `{"type":"kortix.panel.route","path","sessionId?"}` | Sent by the app shell on every route change in the panel. A `sessionId` takes a waiting Act tab: the worker adds the tab to that session's Kortix tab group, at attach or at once. |

Panel → page:

| Message | When |
|---|---|
| `{"type":"kortix.panel.tab","tab":PanelTab\|null}` | On hello, and when the active tab of the panel's window changes or loads. |
| `{"type":"kortix.panel.context","tab","quote?"}` | After a right-click on "Ask Kortix about this selection" or "…this page". |
| `{"type":"kortix.panel.tabs.result","requestId","tabs":[PanelTab]}` | |
| `{"type":"kortix.panel.read.result","requestId","pages":[…]}` | A page is `{tabId,title,url,text,truncated}` or `{tabId,error:"unreadable"}`. |

`PanelTab` = `{id,title,url,readable}`. `readable` is false for Chrome's own
pages and the Web Store: Chrome lets no extension script run there.

Send hands the prompt to the project home composer (`setPrefill(…, {submit:true})`),
which sends it as a typed message does. Read attaches each page as a Markdown
file (`<title>.md`: title, address, read time, text). A selection rides in the
prompt as a quote; the page text goes only when the person adds "Whole page".
Act appends one English line that names the tab, and posts `kortix.panel.act`.
The extension reads a tab only on `kortix.panel.read`, and the page asks only
when the person presses Send.
