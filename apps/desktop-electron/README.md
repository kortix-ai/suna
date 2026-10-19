# @kortix/desktop-electron

An **Electron** build of the Kortix desktop shell, built as a 1:1 behavioral
port of the Tauri shell (`apps/desktop`). It exists so we can compare the two
side by side and pick whichever is less quirky to maintain.

Both shells are thin native wrappers around the **remote** web app
(`http://localhost:3000` in dev, `https://kortix.com` in prod). They share the
same web codebase unchanged — see "Parity" below.

## Why an Electron port?

Tauri's macOS WKWebView routes **every** navigation, including cross-origin
`<iframe>` loads, through the Rust `on_navigation` hook. That broke the
Pipedream **Connect** overlay (an iframe to
`pipedream.com/_static/connect.html`): it got punted to the system browser and
failed with **"Must be inside iframe."** Electron's `will-navigate` fires for
the **top frame only**, so embedded iframes "just work" — no allow-list needed.
(The Tauri shell is also fixed, by allow-listing `pipedream.com` for iframe
loads.)

Electron also gives us native `-webkit-app-region` window dragging (Tauri needs
a JS mousedown→`startDragging` shim), a real branded splash window for the
remote-load gap, and fewer WKWebView surprises generally.

## Run it (dev)

```bash
pnpm install                  # at repo root (Electron binary self-downloads on first `dev` — see note)
pnpm dev                      # repo root: start the web app on :3000
pnpm dev:desktop-electron     # repo root: launch the Electron shell → :3000
```

> Note: this repo sets `ignore-scripts=true` and runs pnpm 8, so Electron's
> binary doesn't download during `pnpm install`. The `dev` script self-heals via
> `scripts/ensure-runtime.js` (it fetches the runtime on first launch).

Point it at a different backend without a rebuild:

```bash
pnpm --filter @kortix/desktop-electron dev:dev-env    # https://dev.kortix.com
pnpm --filter @kortix/desktop-electron dev:prod-env   # https://kortix.com
# or:
KORTIX_DESKTOP_URL=https://kortix.com/projects pnpm --filter @kortix/desktop-electron dev
```

At runtime you can also switch via the native menu (the **Kortix** menu: the
macOS app menu, the first menu on Windows and Linux). A **dev build**
(`kortixUpdateChannel: "dev"`, product "Kortix Dev") keeps the full
**Kortix → Frontend URL** switcher (Production / Dev / Local / Custom… /
Reset). A **production build** hides the developer presets and shows one
**Kortix → Change Kortix Instance…** item that opens the same instance-chooser
window as first launch, so a self-hoster still sets a custom URL. The choice is
remembered across launches (stored in `userData/frontend_url`).
`KORTIX_DESKTOP_USER_DATA=<dir>` runs against an isolated profile instead of
the real one.

Launch and **Go ▸ Home** load the instance's site root (`homeUrl()` in
`src/instance-store.js`), not the saved `/projects` URL. The web middleware
sends a signed-in `/` into the project this profile had open last, from the
owner-scoped `kortix_last_project` cookie — the same as `kortix.com` in a
browser. With no remembered project it lands on the `/projects/start` door. A
saved URL with any other path loads as saved.

**Go ▸ Copy Current URL** (⌘/Ctrl+L) copies the address the window is on — the
session URL inside a session — so it can be pasted and shared. It is enabled
only on app pages (the same in-app routes the navigation gate allows); on a
blank, error, or external page it is disabled.

### The application menu and the title bar on each OS

`src/app-menu.js` builds the menu as a pure function of the platform
(`app-menu.test.js`). Every OS has the same app-level actions:

| Menu | macOS | Windows, Linux |
| --- | --- | --- |
| **Kortix** | About Kortix, Settings… (⌘,), Check for Updates…, Change Kortix Instance…, Services, Hide, Hide Others, Show All, Quit | About Kortix, Settings… (Ctrl+,), Check for Updates…, Change Kortix Instance…, Quit Kortix (Ctrl+Q) |
| File, Edit, View, Go, Window | same on every OS | same on every OS |

A dev build shows **Frontend URL** (the preset switcher) in place of Change
Kortix Instance….

Title bar:

- **macOS.** `titleBarStyle: 'hidden'`; the traffic lights share the 40 px band
  with the page's first row (`MAC_TITLEBAR` in `src/window-chrome.js`).
- **Windows.** `titleBarStyle: 'hidden'` + `titleBarOverlay`: no Win32 title
  bar and no menu-bar strip. Windows draws minimize, maximize and close over
  the top-right corner of the page (138 × 40 window px, transparent, glyphs in
  the theme's foreground). The page's first row shares that band, and the web
  app draws a menu button (☰) in its left slot. The button and a lone **Alt**
  press open the Kortix application menu. Keyboard accelerators work without
  a menu bar. The geometry is `WIN_TITLEBAR` in `src/window-chrome.js`,
  mirrored by `html[data-desktop-titlebar='overlay']` in
  `apps/web/src/app/globals.css`; the preload's `kortixDesktop.titlebar`
  sets that marker, so a web app with a native-frame shell never gets it.
- **Linux.** The native frame. The menu bar hides until Alt.

The Windows app icon (`build/icon.ico`, 16 to 256 px) is the symbol on the
light rounded tile from `apps/web/public/favicon.svg`. Regenerate it with
`python3 scripts/build-win-icon.py` (needs `rsvg-convert` and Pillow); never
hand-edit it. The installer and uninstaller use the same file.

### First launch: choose a Kortix instance

A new profile asks which instance to connect to before any page loads. The
window is `src/instance-chooser.js` + `assets/instance-chooser.html`; URL rules
and the reachability check are `src/instance-rules.js`; `frontend_url`, the
first-launch marker, and URL precedence are `src/instance-store.js`.

- **Kortix Cloud** — the URL baked in at build time (`kortix.com` for prod,
  `dev.kortix.com` for dev builds). Nothing is written to `frontend_url`, so the
  app keeps following the baked default.
- **Self-hosted** — the URL the user types. A bare host gets `https://` (a bare
  `localhost` gets `http://`), a `/` path becomes `/projects`, and query and
  fragment are dropped. URLs with a username or password are rejected. The app
  sends `HEAD` with no credentials and an 8 s timeout; any HTTP status counts as
  reachable. A network error shows inline, with **Continue Anyway** for hosts
  that are only reachable on a VPN. The URL is saved to `frontend_url`.

Rules:

- "New profile" = `userData` is missing or empty at process start. The shell
  then writes `userData/instance_setup_pending` and removes it once the user
  chooses. Quitting the chooser asks again on the next launch.
- Existing installs have a non-empty `userData` and are never asked.
- `KORTIX_DESKTOP_URL` or a saved `frontend_url` skips the chooser, so
  `pnpm dev` and the native e2e journey never see it.

The same window opens from the frontend-URL menu entry (**Frontend URL →
Custom URL…** on dev builds, **Change Kortix Instance…** on production builds),
and when the app origin fails to load (`did-fail-load` on the main frame): the
title reads
**Can't reach \<host\>**, with **Try Again** or a different instance. To see the
first-launch chooser locally, launch without `KORTIX_DESKTOP_URL` on an empty
profile:

```bash
pnpm --filter @kortix/desktop-electron run setup
KORTIX_DESKTOP_USER_DATA="$(mktemp -d)" pnpm --filter @kortix/desktop-electron exec electron .
```

### The dev/staging environment password (HTTP Basic)

`dev.kortix.com` and `staging.kortix.com` sit behind one shared HTTP Basic
credential (`apps/web/src/middleware.ts` answers `401 Authentication required.`).
Chrome pops its own username/password dialog for that; Electron does not, so the
shell handles the challenge itself (`src/main.js` → `answerBasicChallenge`, policy
in `src/basic-auth.js`):

1. `KORTIX_DESKTOP_BASIC_PASSWORD` (+ optional `KORTIX_DESKTOP_BASIC_USER`,
   default `kortix`) answers silently — for CI and scripted launches.
2. Otherwise a credential the user entered earlier for that host answers
   silently. "Remember on this device" stores it in `userData/basic_auth.json`,
   encrypted with Electron `safeStorage` (macOS Keychain / DPAPI / libsecret).
3. Otherwise a native-style sign-in dialog (`assets/basic-auth.html`) opens over
   the app window. A rejected password (the server re-challenges within 60 s)
   drops the remembered copy and reopens the dialog with an error. Cancel leaves
   the bare 401 page, like Chrome; reload asks again.

Origin credentials are sent only to the configured app origin. Any other
origin challenge from a sandbox preview or iframe is refused. Proxy challenges
open the same dialog, but use a separate credential entry keyed by proxy host
and port. The app-origin environment variables never answer a proxy challenge.
**Kortix → Frontend URL → Forget Saved Environment Password** (dev builds)
clears the remembered credential for the current host.

### Testing login (the `kortix://` deep link)

App login (Google etc.) opens in your **real browser** and returns to the app via
the `kortix://auth/callback` deep link. The OS only routes `kortix://` to a
**bundled** app, so for a clean end-to-end login test run the packaged build:

```bash
pnpm --filter @kortix/desktop-electron dev:macos   # builds an unpacked .app + opens it
```

Plain `pnpm dev` (unpackaged `electron .`) is great for fast iteration, and your
session persists across relaunches — but a *fresh* login won't round-trip back
until you run the bundled build above.

## Quick Entry (global shortcut)

**Command+Shift+Space** (Ctrl+Shift+Space on Windows and Linux) opens a prompt
bar over any app: 760 px wide, centered near the bottom of the display, with a
soft shadow and a light dim (25% black) over the rest of that display. The bar
rises and fades in with the dim over 250 ms and drops and fades out over 150 ms
(none with Reduce Motion).
Enter starts a new session with that prompt. The same bar opens from
**File ▸ Open Quick Entry**.

- **Where the session starts.** The project the app window shows, else the
  project this profile opened last (the `kortix_last_project` cookie). The bar
  reads "New session"; its tooltip names the project. With no project known, the prompt
  opens `/projects/start?q=…`: it fills the composer there and does not send.
- **Send to a recent session.** The picker on the right of the bar is a native
  menu: "New session", then the person's 5 most recent root sessions there
  (the sidebar's list, title and status dot, plus last activity). A pick stays
  for the next open while its session is running, starting or needs you
  (`keptPick`); otherwise the bar opens on a new session. The web app
  publishes the list with `quick_entry_set_target`; a picked prompt is taken
  as `{ text, projectId, sessionId }` and submitted by that session's composer
  (Enter semantics: a running turn is steered). The session page moves the
  prefill from the route id onto the chat id when the chat resolves.
- **How it sends.** The bar never calls Kortix. Enter stores the prompt in the
  main process, brings the app window forward, and pokes it
  (`kortix:quick-entry`, no text). The web app pulls the prompt once with the
  sender-gated `quick_entry_take` command and submits it from the project home
  composer: the same agent, model, billing gate and warm session as a typed
  message (`apps/web/src/components/desktop/desktop-quick-entry.tsx`). A
  window that is still loading, or signed out, takes it when the app mounts.
  An untaken prompt expires after 10 minutes.
- **Agent (new session).** The row under the prompt has the project-home
  composer's agent picker. The web app runs the composer's own selection hooks
  headless (`desktop-quick-entry-composer.tsx`) and publishes the agents and
  the resolved selection in `quick_entry_set_target` (`composer`). A pick in
  the native menu is sent to the app window (`kortix:quick-entry-select`) and
  applied with the composer's own setter; the bar shows what the app sends
  back. The model and effort are the composer's own for that agent. On send,
  the prefill carries `options`, and `ComposerChatInput` applies agent, then
  model, then effort, one per commit, before the composer submits.
- **Files and screenshots.** Paperclip, paste or drop; at most 10 files of
  20 MB each (`normalizeAttachments`). On macOS the camera button hides the bar
  and runs `screencapture -i` (region, or Space for a window); the image comes
  back as a thumbnail. Without Screen Recording access the first click runs a
  `desktopCapturer` capture, which shows the macOS prompt and lists Kortix, and
  the bar links to the privacy pane; macOS applies a grant after Kortix restarts.
  An unpackaged build started from a terminal is listed as that terminal app
  (iTerm, Terminal): macOS credits the app that launched it. Files reach the web app
  in `quick_entry_take` and are staged by the composer like any attachment. A
  screenshot for a model whose catalog says it cannot read images fills the
  composer instead of sending.
- **Keys.** Enter sends. Shift+Enter adds a line. Esc, the shortcut again, or a
  click in another app closes the bar and keeps the typed text for the next
  open. The prompt replaces an unsent draft in the project home composer.
- **Choose the shortcut.** **File ▸ Quick Entry Shortcut** or **Settings ▸
  Preferences ▸ Keyboard shortcuts ▸ Quick Entry** (the web app calls
  `quick_entry_shortcut` / `quick_entry_set_shortcut`): Command+Shift+Space
  (default), Option+Space, Option+Shift+Space, or Off. The choice is saved in
  `userData/quick_entry.json`. A shortcut another app holds shows "(in use)".
  Option+Space is not the default because Claude and ChatGPT use it.
- **macOS.** The bar is a non-activating panel: it takes keys over a
  full-screen app and on every Space, and the app you typed over stays active
  until you press Enter. A Kortix hidden with Command+H stays hidden after Esc.
- **Linux.** Electron has no global shortcuts under Wayland. Use the menu item.

Files: `src/quick-entry.js` (window, shortcut, IPC), `src/quick-entry-rules.js`
(choices, placement, expiry; tested), `src/quick-entry-preload.js`,
`assets/quick-entry.html`. The native journey in
`tests/e2e/specs/27-desktop-parity.spec.ts` drives it end to end.

## Unseen finished turns (Dock / taskbar badge)

A turn that finishes while you work elsewhere puts a count on the app icon. The
count is the number of sessions with a finished turn you have not seen yet. The
in-app toast fades after 8 s; the badge stays until you look.

- **What counts.** The web app's turn-attention store
  (`apps/web/src/stores/turn-attention-store.ts`). A turn counts when it
  finishes while the window is hidden or not focused, including on the session
  the window shows. It also counts when it finishes while another session is on
  screen and the app still hears it (another window or browser tab has it
  open). Looking at the session in a focused window removes it from the count.
- **How it reaches the icon.** `TurnAttentionBadge` sends the count through the
  sender-gated `set_badge_count` command (`setDesktopBadgeCount` in
  `apps/web/src/lib/desktop.ts`), and `src/attention-badge.js` shows it:

  | Platform | Shows |
  | --- | --- |
  | macOS | the number on the Dock icon (`app.setBadgeCount`) |
  | Windows | a green dot over the taskbar icon (`setOverlayIcon`), with the count in its accessible description |
  | Linux | the number on the launcher icon, where the desktop supports Unity launcher counts |

- **When it clears.** At 0, on every new document in the window (reload,
  server switch), and when the window closes.

## Right-click menu

A right-click in the app window or the Quick Entry bar shows the menu a browser
shows (`src/context-menu.js`, KRTX-2555). Without a `context-menu` handler,
Chromium shows nothing.

| Where | Items |
| --- | --- |
| A misspelled word | up to 5 suggestions (or **No Guesses Found**), **Add to Dictionary** |
| A link | **Open Link in Browser** (web and mail links only), **Copy Link** |
| An image | **Copy Image**, **Copy Image Address** |
| A text field | Undo, Redo, Cut, Copy, Paste, Paste and Match Style, Select All, each enabled as the field allows |
| Selected text elsewhere | Copy |

- An empty area of the page shows no menu.
- A page element with its own right-click menu calls `preventDefault` on
  `contextmenu`; Chromium then sends the shell no event, so the page's menu
  wins.
- On macOS a right-click also selects the word under the pointer, so Copy can
  follow the link items.

## This computer (local agent + tray)

The app bundles the computer agent, `@kortix/agent-tunnel`
(`packages/agent-tunnel/dist/agent-cli.js`), as
`Resources/agent-tunnel/agent-cli.js`, with the package's `package.json` beside
it for the version (electron-builder `extraResources`; `desktop.yml` stamps the
release version into that `package.json`, because the checked-in value is inert). It
runs that file with its own binary: `process.execPath` +
`ELECTRON_RUN_AS_NODE=1`. The installed OS service (launchd / systemd user unit
/ Scheduled Task) does the same, so a connected computer needs no Node install.
Dev runs load the repo build; `scripts/ensure-runtime.js` builds it with bun
when it is missing.

Pieces: `src/computer.js` (rules, NDJSON parsing, spawning, access.json;
unit-tested) and `src/computer-tray.js` (commands, approval window, access
prompt, tray).

| `kortix:invoke` command | Result |
| --- | --- |
| `computer_status` | `{ available, paired, tunnelId?, apiUrl?, status?, state?, paused, serviceInstalled, serviceActive, needsRepair, error? }`. `state` is `online`, `connecting`, `offline`, `rejected` (needs reconnect) or `standby`. Answered from the cached status; file changes keep it fresh. |
| `computer_connect { projectId?, share?, apiUrl?, reauth? }` | Runs `connect --json --daemon --api-url <backend>/tunnel [--project-id <id>] [--reauth]`; opens the approval page in a modal window; resolves `{ ok, tunnelId, existing? }` or `{ ok: false, error }` once the service is installed. `share` is chosen on the approval page. |
| `computer_pause` / `computer_resume` | The agent's durable `stop` / `start`. Returns `{ ok, error?, status }`. Pause survives login and reboot. |
| `computer_disconnect` | `logout --json`: removes the machine in Kortix with its own credential (`DELETE /v1/tunnel/self`), then the local credential and the service. Returns `{ ok, serverUnpaired, error?, status }`. |
| `computer_open_logs` | Opens `logs/agent-tunnel.out.log`; rejects when the OS cannot open it. |
| `computer_access_get` | `{ mode, grantedUntil, deniedUntil, keepAwake, keepAwakeSupported, pendingRequest }` |
| `computer_access_set { mode?, grantMinutes?, revoke?, keepAwake? }` | Writes `access.json` (grant at most 24 h); returns the same shape. |

Rules:

- The commands pass the same trusted-sender gate as every other command: the
  main frame of the main window, on the configured app origin.
- **The backend comes from the instance, not the page.** The main process reads
  `BACKEND_URL` from `<app origin>/api/runtime-config` (https, or http on
  loopback) and caches it in `<userData>/computer-backend.json` for offline
  starts. A page that still passes `apiUrl` must name exactly that backend.
- The approval URL loads in-app only when it is this app's `/tunnel/` route;
  anything else opens in the system browser. Closing that window cancels the
  pairing only when no approval arrives within 10 s: the agent learns of an
  approval on its next 2 s poll.
- The approval window is a dialog, not a second app window. On macOS it is a
  sheet with no close button. **Esc** and the page's **Back** close it; so
  does any navigation to an app page outside `/tunnel/*` and `/auth*`
  (`isApprovalDialogPath` in `src/nav-rules.js`). Each counts as closing the
  window, with the same 10 s grace. The app never loads inside the dialog.
- A packaged macOS app must run from `/Applications`; a translocated copy would
  leave the service pointing at a path that disappears.
- **Isolation, one identity per backend.** A packaged **stable** build on
  `https://api.kortix.com` uses the default `~/.agent-tunnel` and service
  `ai.kortix.agent-tunnel`, the same identity as the npm CLI. So does a stable
  build whose `~/.agent-tunnel` already pairs the same backend. Every other
  backend gets `AGENT_TUNNEL_HOME=<userData>/agent-tunnel/<sha8(api origin)>`
  and a suffixed service `ai.kortix.agent-tunnel.<8 hex>`. A pre-v2
  `<userData>/agent-tunnel` keeps being used while it pairs the same backend.
  A packaged stable build uses `~/.agent-tunnel` only when it is unpaired or
  paired with this same backend. A saved token is never sent to another
  backend, and `pnpm dev` never touches the real agent.
- **Service repair.** On start, and from the periodic status refresh at most
  once every 5 minutes, a paired service that is not paused is reinstalled
  (`install-service`) when it is missing, not running, its unit differs from
  what this app would write (app moved or updated), or it runs an agent version
  other than the bundled one. A foreground `agent-tunnel connect` that holds
  the tunnel is left alone. On macOS a copy that does not run from the
  Applications folder (disk image, App Translocation) never repairs and never
  records itself.
- **Access prompt.** The app records itself in `<home>/desktop-app.json` (the
  AppImage file on Linux) and touches it every 5 s, so the agent can tell a
  running app from a reused pid and start it. When `access-request.json`
  appears and access is not already decided, the app shows a native dialog on
  top of every app ("Allow Kortix to use <machine>?": Allow for 24 hours, Allow
  for 1 hour (default), Deny). The dialog says a grant covers files, the shell,
  and the screen and keyboard for any agent that can reach the computer. A
  system notification appears when no window has focus. An answer clears every
  request asked before it.
- **Access from the web page.** `computer_access_set` narrows access at once
  (Off, Ask each time, Revoke, keep awake). Widening it (Always allowed, or a
  new grant) applies only after the owner clicks Allow in a native dialog: the
  page is remote content and never decides alone. A mode change drops the old
  grant and denial.

The tray (macOS menu bar template icon, Windows/Linux notification area) exists
while a computer is paired. Its status line follows `state.json` (fs.watch plus
a 5 s mtime poll; a full status refresh every 60 s). Items: Open Kortix; Access
(Ask each time / Always allowed / Off); "Allowed until HH:MM" and Revoke now
while a grant runs; Keep this computer awake while plugged in (macOS, Linux;
shown disabled on Windows); Pause/Resume computer access; Show logs;
Open at login (macOS and Windows); Disconnect this computer… (same self-unpair
as the web); Quit Kortix. Failures show an error dialog. With a paired
computer, closing the last window keeps the app in the tray on every platform.
The agent is a separate OS service and stays connected after Quit.

Tray icons are in `assets/tray/`: `trayTemplate.png` / `@2x` (black + alpha,
from `apps/web/public/kortix-symbol.svg`) and `tray.png` / `tray.ico` (from
`build/icon.png`).

## Kortix Capture

Kortix Capture is not part of this app. It is a standalone app (`apps/capture` in this repository) that a person installs and signs in to with their Kortix
account, or that IT installs with an enrollment token. Its admin pages
(`/capture/...`: Devices, timelines, policy, rollout) open in this app like
any other Kortix page.

## Package

```bash
pnpm build            # current OS  → dist/
pnpm build:mac | build:win | build:linux
```

Icons live in `build/` (`icon.icns` / `icon.ico` / `icon.png`). Code signing /
notarization are env-driven (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY*`,
`WIN_CSC_LINK`, …); unsigned local builds are fine for testing.

Windows installers are Authenticode-signed through Microsoft Artifact Signing
(`win.azureSignOptions`, publisher "Kortix AI Corp") when `kortix-ci-env` holds
`AZURE_SIGNING_TENANT_ID`, `AZURE_SIGNING_CLIENT_ID`, `AZURE_SIGNING_CLIENT_SECRET`,
`AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE`
(the same values Kortix Capture uses). `desktop.yml` and `deploy-prod.yml` then
fail the build unless every `dist/*.exe` is `Valid`. Without them the installer
is unsigned and SmartScreen shows "Unknown publisher" on download.

## Auto-update

The installed app self-updates via **electron-updater**, reading the `vX.Y.Z`
**GitHub Releases** as its feed (the `publish: github` block in
`electron-builder.yml` bakes an `app-update.yml` pointing at `kortix-ai/suna`).

Flow (`src/updater.js`, wired from `src/main.js`):

1. On launch it checks GitHub for a newer release. While the splash is up it
   shows `Checking…/Downloading… N%`.
2. A newer version downloads in the **background** — the window stays usable; we
   never block on the download.
3. Once staged, a native **"Restart to update"** dialog appears. Declining keeps
   the update; it installs on the next quit (`autoInstallOnAppQuit`). A 6-hour
   re-check covers long sessions, and **Kortix → Check for Updates…** runs it on
   demand with explicit feedback.

For this to work the release must carry the electron-updater **metadata** —
`latest*.yml`, the `*.blockmap`s, and (macOS only) the update **`.zip`** that
Squirrel.Mac installs from. The dmg/exe/AppImage is the first-install download;
the zip + yml are what the updater consumes. CI (`deploy-prod.yml` for prod,
`desktop.yml` for dev and staging) builds the mac zip target and uploads all of
these to the release.

Each deployment's `/download` hands out the build that opens it. The web app keys
the channel on its backend host (`deploymentChannel()` in
`apps/web/src/features/marketing/download/releases.ts`):

| Deployment | Release served | Product | Built by |
|---|---|---|---|
| `kortix.com`, self-hosted, local | newest `vX.Y.Z` | Kortix | `deploy-prod.yml` |
| `dev.kortix.com` | `desktop-dev-latest` | Kortix Dev | `gh workflow run desktop.yml -f channel=dev` |
| `staging.kortix.com` | `desktop-staging-latest` | Kortix Staging | `gh workflow run desktop.yml -f channel=staging` |

A channel prerelease keeps every build it ever published; `/download` serves the
newest version in it. When the channel has no installer, `/download/<platform>`
sends the visitor to that prerelease, never to the production installer.

Scope: auto-update runs only for **packaged, stable-channel** builds. Unpackaged
`electron .` dev runs can't self-update; the **`dev`** and **`staging`**
channels (the mutable `desktop-<channel>-latest` prereleases) opt out so they
never cross-update to a prod installer. macOS additionally requires the build to be **signed +
notarized** — CI signs when the cert secrets are present.

> End-to-end note: a true download→install→relaunch can only be exercised
> against two signed, published releases. To test the *check* locally, build a
> packaged app (`pnpm build:mac`) — it will reach GitHub and either find a newer
> release or report "up to date".

## Parity with the Tauri shell

The web app talks to the native shell through exactly one module —
`apps/web/src/lib/desktop.ts` — which uses `window.__TAURI__` and the
`KortixDesktop` user-agent token. This port reproduces **both**, so the web app
runs **unchanged** on either shell:

| Concern | Tauri (`apps/desktop`) | Electron (this app) |
| --- | --- | --- |
| Detection | `KortixDesktop` UA token | same token appended to UA |
| Native bridge | `window.__TAURI__` (global Tauri) | `window.__TAURI__` shim in `preload.js` |
| External `_blank` links | JS shim → `open_external` IPC | `setWindowOpenHandler` → `shell.openExternal` |
| OAuth/connect popups (Pipedream) | ✗ blocked (`window.open`→null) | ✓ real child window (works) |
| App login | system browser + `kortix://` | system browser + `kortix://` |
| Zoom (`set_zoom`) | Rust command | `webContents.setZoomFactor` |
| Unseen-turn badge (`set_badge_count`) | ✗ none | Dock count / taskbar overlay (`attention-badge.js`) |
| Right-click menu | ✗ none | spelling, edit, link and image items (`context-menu.js`) |
| Window controls | `getCurrentWindow().*` | IPC → `BrowserWindow.*` |
| Frontend URL override | app-config-dir file + menu | `userData/frontend_url` + same menu |
| Deep links (`kortix://`) | deep-link plugin | `setAsDefaultProtocolClient` + `open-url`/`second-instance` |
| Nav gate (in-app vs browser) | `on_navigation` (also fires for iframes) | `will-navigate` (top frame only) |
| Window dragging | JS `startDragging` shim | native `-webkit-app-region` CSS |
| Window-state persistence | window-state plugin (maximized only) | `userData/window_state.json` (bounds and maximized state; off-screen bounds recenter) |
| Launch size | ~85% display, clamped | identical |
| Startup gap | blank window | branded splash window |
| Auto-update | ✗ none (manual re-download) | ✓ electron-updater (GitHub releases) |

### OAuth: two flows, handled differently (on purpose)

- **App login** (Supabase `/auth/v1/*`, Google, …) → opens in your **real
  browser**, returns via `kortix://auth/callback`. Same model as Tauri; Google
  rejects embedded webviews and a real browser is the trustworthy place to sign
  in. The nav gate routes any `/auth/v1/*` navigation out to the browser.
- **Pipedream Connect / connector popups** → open **in-app** as a child window.
  Pipedream opens the provider via `window.open` and waits for a `postMessage`
  back into its iframe — that handshake only works with a real popup that has a
  `window.opener`. **This is the bug Tauri can't fix** ("Connect account popup
  blocked"): Tauri forces `window.open` to return `null`. Electron's
  `setWindowOpenHandler` returns a genuine child window, so it works.

### Known caveat

- Prod sandbox previews served over plain HTTP inside an HTTPS page are
  mixed-content; Chromium is stricter than WKWebView here. Revisit if it bites.
